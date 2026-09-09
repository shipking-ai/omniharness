package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"omniharness/internal/event"
	"omniharness/internal/policy"
	"omniharness/internal/tools"
)

func ask(b *approvalBroker) (chan bool, chan error) {
	granted, errs := make(chan bool, 1), make(chan error, 1)
	go func() {
		g, err := b.RequestApproval(context.Background(),
			policy.Request{Tool: "git", Risk: tools.RiskHigh, AgentID: "a1"}, "git push requires explicit approval")
		granted <- g
		errs <- err
	}()
	return granted, errs
}

// waitPending blocks until the broker has registered a question, so tests do
// not race the goroutine that asks.
func waitPending(t *testing.T, b *approvalBroker) pendingApproval {
	t.Helper()
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); {
		if list := b.list(); len(list) == 1 {
			return list[0]
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("no approval was registered")
	return pendingApproval{}
}

func post(t *testing.T, b *approvalBroker, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	approvalsHandler(b)(rec, httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(body)))
	return rec
}

// The point of the whole thing: a run blocked on a question can be unblocked
// over HTTP. Before this the only options were "approve everything up front"
// or "have risky steps silently denied on the server's own stdin".
func TestApprovalGrantedOverHTTP(t *testing.T) {
	b := newApprovalBroker(event.NewBus(), time.Minute)
	granted, errs := ask(b)
	p := waitPending(t, b)

	if rec := post(t, b, "/v1/approvals/"+p.ID, `{"granted":true}`); rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	select {
	case g := <-granted:
		if !g {
			t.Fatal("the run was denied after the client granted approval")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the run never woke up after being answered")
	}
	if err := <-errs; err != nil {
		t.Fatalf("err = %v", err)
	}
	if len(b.list()) != 0 {
		t.Error("the answered approval is still listed as pending")
	}
}

func TestApprovalDeniedOverHTTP(t *testing.T) {
	b := newApprovalBroker(event.NewBus(), time.Minute)
	granted, _ := ask(b)
	p := waitPending(t, b)

	post(t, b, "/v1/approvals/"+p.ID, `{"granted":false}`)
	select {
	case g := <-granted:
		if g {
			t.Fatal("the run proceeded after the client denied it")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the run never woke up")
	}
}

// The question has to reach the client, and it has to carry an id — otherwise
// the only possible answer is "approve whatever is waiting", which races as
// soon as two agents ask at once.
func TestApprovalIsAnnouncedOnTheBusWithAnID(t *testing.T) {
	bus := event.NewBus()
	sub, unsub := bus.Subscribe(8)
	defer unsub()
	b := newApprovalBroker(bus, time.Minute)
	ask(b)

	select {
	case e := <-sub:
		if e.Type != event.ApprovalRequested {
			t.Fatalf("first event = %s, want %s", e.Type, event.ApprovalRequested)
		}
		var data event.ApprovalData
		if err := json.Unmarshal(e.Data, &data); err != nil {
			t.Fatal(err)
		}
		if data.ID == "" {
			t.Error("the announced approval has no id, so a client cannot answer it")
		}
		if data.Tool != "git" || data.Reason == "" {
			t.Errorf("announced payload = %+v, want the tool and the reason", data)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no approval.requested event was published")
	}
}

// A client that closes its laptop must not wedge an agent forever, and expiry
// must deny: the engine asked precisely because this is not an action to take
// unattended.
func TestApprovalTimesOutIntoADenial(t *testing.T) {
	b := newApprovalBroker(event.NewBus(), 150*time.Millisecond)
	granted, errs := ask(b)
	select {
	case g := <-granted:
		if g {
			t.Fatal("an unanswered approval was granted")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the run was still blocked well past the timeout")
	}
	if err := <-errs; err != nil {
		t.Fatalf("a timeout should be a denial, not an error: %v", err)
	}
}

// A cancelled run must stop waiting, and must not have a decision recorded
// against it — nobody decided anything.
func TestApprovalStopsWaitingWhenTheRunIsCancelled(t *testing.T) {
	bus := event.NewBus()
	sub, unsub := bus.Subscribe(16)
	defer unsub()
	b := newApprovalBroker(bus, time.Minute)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := b.RequestApproval(ctx, policy.Request{Tool: "git", Risk: tools.RiskHigh}, "why")
		done <- err
	}()
	waitPending(t, b)
	cancel()

	select {
	case err := <-done:
		if err == nil {
			t.Error("a cancelled wait returned no error")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the approval kept waiting after the run was cancelled")
	}
	// Drain: only the request should have been announced.
	for {
		select {
		case e := <-sub:
			if e.Type == event.ApprovalGranted || e.Type == event.ApprovalDenied {
				t.Errorf("a %s decision was recorded for a cancelled run", e.Type)
			}
		case <-time.After(200 * time.Millisecond):
			return
		}
	}
}

func TestApprovalRejectsBadRequests(t *testing.T) {
	b := newApprovalBroker(event.NewBus(), time.Minute)

	// An omitted "granted" must not be read as false: denying because a client
	// forgot a key is the wrong kind of quiet.
	if rec := post(t, b, "/v1/approvals/abc", `{}`); rec.Code != http.StatusBadRequest {
		t.Errorf("missing granted = %d, want 400", rec.Code)
	}
	if rec := post(t, b, "/v1/approvals/abc", `not json`); rec.Code != http.StatusBadRequest {
		t.Errorf("bad json = %d, want 400", rec.Code)
	}
	// An unknown id is a 404, so a client can tell a real answer from a stale one.
	if rec := post(t, b, "/v1/approvals/nope", `{"granted":true}`); rec.Code != http.StatusNotFound {
		t.Errorf("unknown id = %d, want 404", rec.Code)
	}
	rec := httptest.NewRecorder()
	approvalsHandler(b)(rec, httptest.NewRequest(http.MethodGet, "/v1/approvals/abc", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET on one approval = %d, want 405", rec.Code)
	}
}

// A client that reconnects after a refresh missed the events and has no other
// way to discover that a run is blocked on it.
func TestPendingApprovalsAreListable(t *testing.T) {
	b := newApprovalBroker(event.NewBus(), time.Minute)
	rec := httptest.NewRecorder()
	approvalsHandler(b)(rec, httptest.NewRequest(http.MethodGet, "/v1/approvals", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var empty struct {
		Approvals []pendingApproval `json:"approvals"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&empty); err != nil {
		t.Fatal(err)
	}
	if len(empty.Approvals) != 0 {
		t.Errorf("idle broker lists %d approvals", len(empty.Approvals))
	}

	ask(b)
	p := waitPending(t, b)
	if p.Tool != "git" || p.Risk != string(tools.RiskHigh) || p.Reason == "" {
		t.Errorf("listed approval = %+v, want enough to decide on", p)
	}
}
