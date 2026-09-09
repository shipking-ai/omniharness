package cli

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"omniharness/internal/event"
	"omniharness/internal/id"
	"omniharness/internal/policy"
)

// defaultApprovalTimeout bounds how long a run waits for an answer.
//
// A client that closes its laptop must not wedge an agent forever, and the run
// is holding a model turn open while it waits. Expiry denies rather than
// grants: the whole reason the engine asked is that this action is not one to
// take unattended.
const defaultApprovalTimeout = 5 * time.Minute

// pendingApproval is one question waiting for an answer.
type pendingApproval struct {
	ID        string    `json:"id"`
	Tool      string    `json:"tool,omitempty"`
	Risk      string    `json:"risk,omitempty"`
	AgentID   string    `json:"agentId,omitempty"`
	Reason    string    `json:"reason,omitempty"`
	Requested time.Time `json:"requested"`

	reply chan bool
}

// approvalBroker is the Approver for `omniharness serve`: it turns a blocking
// policy question into something an HTTP client can answer.
//
// Before it, the server's approver was the terminal prompter, which writes to
// the *server's* stderr and reads the *server's* stdin. Under a daemon that is
// nobody: with stdin not a terminal every request was auto-denied and the
// reason went to a console the client could not see, and with one it blocked
// on whoever happened to be sitting at the machine. So an HTTP client's only
// real option was approveAll — "approve everything up front" or "have risky
// steps silently denied".
type approvalBroker struct {
	bus     *event.Bus
	timeout time.Duration

	mu      sync.Mutex
	pending map[string]*pendingApproval
}

func newApprovalBroker(bus *event.Bus, timeout time.Duration) *approvalBroker {
	if timeout <= 0 {
		timeout = defaultApprovalTimeout
	}
	return &approvalBroker{bus: bus, timeout: timeout, pending: map[string]*pendingApproval{}}
}

// RequestApproval implements policy.Approver. It announces the question on the
// event bus — which is how a client watching /v1/events learns of it — and
// blocks until someone answers, the run is cancelled, or the timeout expires.
func (b *approvalBroker) RequestApproval(ctx context.Context, r policy.Request, reason string) (bool, error) {
	// Auto-approval is handled by the policy engine before it ever reaches an
	// approver, so anything arriving here is a genuine question.
	p := &pendingApproval{
		ID:        id.New(),
		Tool:      r.Tool,
		Risk:      string(r.Risk),
		AgentID:   r.AgentID,
		Reason:    reason,
		Requested: time.Now().UTC(),
		// Buffered: a resolver must never block, and must not deadlock against
		// a requester that has already given up on the timeout.
		reply: make(chan bool, 1),
	}

	b.mu.Lock()
	b.pending[p.ID] = p
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		delete(b.pending, p.ID)
		b.mu.Unlock()
	}()

	b.publish(&event.ApprovalData{
		ID: p.ID, Tool: p.Tool, Risk: p.Risk, Requester: p.AgentID, Reason: reason,
	})

	timer := time.NewTimer(b.timeout)
	defer timer.Stop()

	select {
	case granted := <-p.reply:
		b.decided(p, granted, reason)
		return granted, nil
	case <-ctx.Done():
		// The run went away — cancelled, or its deadline passed. Nothing to
		// decide; do not record a decision nobody made.
		return false, ctx.Err()
	case <-timer.C:
		b.decided(p, false, reason+" (denied: no answer within "+b.timeout.String()+")")
		return false, nil
	}
}

func (b *approvalBroker) decided(p *pendingApproval, granted bool, reason string) {
	data := event.ApprovalData{ID: p.ID, Tool: p.Tool, Risk: p.Risk, Requester: p.AgentID, Reason: reason}
	if granted {
		data.Decision = "granted"
		g := event.ApprovalGrantedData(data)
		b.publish(&g)
		return
	}
	data.Decision = "denied"
	d := event.ApprovalDeniedData(data)
	b.publish(&d)
}

func (b *approvalBroker) publish(p event.Payload) {
	if b.bus != nil {
		b.bus.Publish(event.New(p))
	}
}

// resolve answers one pending approval, reporting whether it was still
// waiting. Answering twice is not an error for the caller to worry about — the
// second answer simply finds nothing pending.
func (b *approvalBroker) resolve(approvalID string, granted bool) bool {
	b.mu.Lock()
	p, ok := b.pending[approvalID]
	b.mu.Unlock()
	if !ok {
		return false
	}
	select {
	case p.reply <- granted:
		return true
	default:
		// Already answered; the requester has not woken up yet.
		return false
	}
}

// list returns the questions currently waiting, oldest first. A client that
// reconnects after a refresh missed the events and has no other way to find
// out that a run is blocked on it.
func (b *approvalBroker) list() []pendingApproval {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]pendingApproval, 0, len(b.pending))
	for _, p := range b.pending {
		out = append(out, pendingApproval{
			ID: p.ID, Tool: p.Tool, Risk: p.Risk, AgentID: p.AgentID,
			Reason: p.Reason, Requested: p.Requested,
		})
	}
	sortPendingByRequested(out)
	return out
}

func sortPendingByRequested(p []pendingApproval) {
	for i := 1; i < len(p); i++ {
		for j := i; j > 0 && p[j].Requested.Before(p[j-1].Requested); j-- {
			p[j], p[j-1] = p[j-1], p[j]
		}
	}
}

// approvalsHandler serves GET /v1/approvals and POST /v1/approvals/{id}.
func approvalsHandler(b *approvalBroker) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/v1/approvals"), "/")
		if rest == "" {
			if r.Method != http.MethodGet {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"approvals": b.list()})
			return
		}
		if strings.Contains(rest, "/") {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var body struct {
			Granted *bool `json:"granted"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "bad request: "+err.Error(), http.StatusBadRequest)
			return
		}
		// A pointer, so an omitted field is rejected rather than silently read
		// as false. Denying because a client forgot a key is the wrong kind of
		// quiet.
		if body.Granted == nil {
			http.Error(w, `"granted" is required (true or false)`, http.StatusBadRequest)
			return
		}
		if !b.resolve(rest, *body.Granted) {
			writeJSON(w, http.StatusNotFound, map[string]any{
				"id": rest, "error": "no approval is waiting under that id",
			})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"id": rest, "granted": *body.Granted})
	}
}
