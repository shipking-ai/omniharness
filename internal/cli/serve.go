package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"omniharness/internal/event"
	"omniharness/internal/gateway"
	"omniharness/internal/runtime"
	"omniharness/internal/telemetry"
	"omniharness/internal/version"
)

func newServeCmd() *cobra.Command {
	var (
		port int
	)
	cmd := &cobra.Command{
		Use:   "serve",
		Short: "Run a local headless HTTP API",
		Long: `Starts a loopback-only HTTP API for programmatic task submission and
monitoring.

Requests must address the loopback interface by name, and any Origin they
carry must itself be a loopback origin, so a page on another site cannot drive
this API through DNS rebinding. POST
/v1/tasks runs an agent with tool access, so treat the port as trusted: any
process on this machine can reach it.

The browser UI is served from the same port at http://127.0.0.1:<port>/ and is
compiled into this binary, so it needs no network of its own.

Endpoints:
  GET  /                   the browser UI
  GET  /health             liveness + OmniRoute reachability
  POST /v1/tasks           run a task {prompt, sessionId?}
  POST /v1/tasks/{id}/cancel  stop a running task
  GET  /v1/approvals       questions waiting for an answer
  POST /v1/approvals/{id}  answer one {granted: true|false}
  GET  /v1/events          live event stream (SSE); ?session= and ?types= filter
  GET  /v1/sessions        list sessions
  GET  /v1/sessions/{id}   session detail with metrics

POST /v1/tasks does not return until the task is finished, so watch
/v1/events to follow a run in progress. The stream is lossy under load: the
SSE id is the bus publish counter, so a gap in it means a client fell behind
and should re-read the session rather than assume it saw everything.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runServer(cmd.Context(), port)
		},
	}
	cmd.Flags().IntVar(&port, "port", 20140, "loopback port")
	return cmd
}

// runServer builds the runtime, wires every route and blocks until ctx ends.
//
// Shared by `serve` and `desktop` so the two cannot drift: a route added for one
// is present in the other, and the desktop window is talking to exactly the
// server the docs describe.
func runServer(parent context.Context, port int) error {
	{
		{
			rt, err := newRuntime(parent)
			if err != nil {
				return err
			}
			defer rt.Close()
			// The terminal prompter is useless here: it writes to the server's
			// stderr and reads the server's stdin, neither of which belongs to the
			// client that asked. Questions go to the event stream instead, and
			// answers come back over /v1/approvals.
			approvals := newApprovalBroker(rt.Bus, defaultApprovalTimeout)
			if rootOpts.Yes {
				installApprover(rt, true)
			} else {
				rt.SetApprover(approvals)
			}
			cfg, _ := loadConfig()
			loadMCPServersFromConfig(parent, rt, cfg)

			mux := http.NewServeMux()
			mux.Handle("/", webUIHandler())
			mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
				diag := rt.Gateway.Diagnose(r.Context())
				writeJSON(w, http.StatusOK, map[string]any{
					"ok":              true,
					"version":         version.String(),
					"omniroute":       diag.State == gateway.AuthOK || diag.State == gateway.AuthNotRequired,
					"authState":       string(diag.State),
					"omnirouteDetail": diag.Detail,
				})
			})
			mux.HandleFunc("/v1/tasks", func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost {
					http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
					return
				}
				var req struct {
					Prompt     string `json:"prompt"`
					SessionID  string `json:"sessionId,omitempty"`
					ApproveAll bool   `json:"approveAll,omitempty"`
				}
				if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
					http.Error(w, "bad request: "+err.Error(), http.StatusBadRequest)
					return
				}
				if strings.TrimSpace(req.Prompt) == "" {
					http.Error(w, "prompt is required", http.StatusBadRequest)
					return
				}
				sessionID := req.SessionID
				if sessionID == "" {
					ss, err := rt.NewSession("", truncate(req.Prompt, 60))
					if err != nil {
						http.Error(w, err.Error(), http.StatusInternalServerError)
						return
					}
					sessionID = ss.ID
				}
				ctx, cancel := context.WithTimeout(r.Context(), 30*time.Minute)
				defer cancel()
				tsk, err := rt.RunTask(ctx, sessionID, req.Prompt, runtime.RunOptions{
					ApproveAll: req.ApproveAll,
				})
				if err != nil {
					writeJSON(w, http.StatusOK, map[string]any{
						"sessionId": sessionID,
						"task":      tsk,
						"error":     err.Error(),
					})
					return
				}
				writeJSON(w, http.StatusOK, map[string]any{"sessionId": sessionID, "task": tsk})
			})
			mux.HandleFunc("/v1/tasks/", cancelTaskHandler(rt))
			mux.HandleFunc("/v1/approvals", approvalsHandler(approvals))
			mux.HandleFunc("/v1/approvals/", approvalsHandler(approvals))
			mux.HandleFunc("/v1/events", eventStreamHandler(rt.Bus))
			// The vocabulary of the stream. A client that subscribes by event
			// name has to know every name, and the alternative to publishing the
			// list is a copy of it maintained by hand in each front-end — which
			// drifts, and whose drift shows up as phantom dropped events rather
			// than as anything that looks like a missing subscription.
			mux.HandleFunc("/v1/event-types", func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet && r.Method != http.MethodHead {
					http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
					return
				}
				writeJSON(w, http.StatusOK, map[string]any{"types": event.AllTypes()})
			})
			mux.HandleFunc("/v1/sessions/", func(w http.ResponseWriter, r *http.Request) {
				id := strings.TrimPrefix(r.URL.Path, "/v1/sessions/")
				ss, err := rt.Store.GetSession(id)
				if err != nil {
					http.Error(w, "session not found", http.StatusNotFound)
					return
				}
				tasks, _ := rt.Store.TasksBySession(id)
				m, _ := telemetry.ForSession(rt.Store, id)
				writeJSON(w, http.StatusOK, map[string]any{"session": ss, "tasks": tasks, "metrics": m})
			})
			mux.HandleFunc("/v1/sessions", func(w http.ResponseWriter, r *http.Request) {
				sessions, err := rt.ListSessions(50)
				if err != nil {
					http.Error(w, err.Error(), http.StatusInternalServerError)
					return
				}
				writeJSON(w, http.StatusOK, map[string]any{"sessions": sessions})
			})

			addr := fmt.Sprintf("127.0.0.1:%d", port)
			fmt.Printf("omniharness serve listening on http://%s\n", addr)
			fmt.Printf("  ui   http://%s/\n  api  http://%s/v1\n", addr, addr)
			srv := &http.Server{
				Addr:    addr,
				Handler: guardLoopback(mux),
				// A connection that never finishes sending its headers would
				// otherwise occupy the server indefinitely.
				ReadHeaderTimeout: 10 * time.Second,
				IdleTimeout:       120 * time.Second,
				// No WriteTimeout: a task legitimately runs for minutes, and the
				// handler already bounds it at 30.
			}
			go func() {
				<-parent.Done()
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				srv.Shutdown(ctx)
			}()
			if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				return err
			}
			return nil
		}
	}
}

// guardLoopback rejects requests that a local client would never send.
//
// Binding to 127.0.0.1 keeps the API off the network, but it does not keep a
// browser out. Under DNS rebinding, a page the user is merely visiting can
// resolve its own hostname to 127.0.0.1 and post here; the request arrives on
// the loopback socket like any other. That matters more than usual for this
// API, because POST /v1/tasks runs an agent with full tool access and accepts
// approveAll, which waives the approval gate outright.
//
// Two checks close it, and neither inconveniences a real client:
//
//   - The Host header must name the loopback interface. A rebound request
//     carries the attacker's hostname, because that is what the browser
//     resolved.
//   - Any Origin header must itself name the loopback interface. Browsers
//     attach an Origin to every fetch, so the harness's own UI carries one —
//     but a rebound page's Origin is the attacker's site, which is not
//     loopback and is refused. curl and the Go client send none at all.
func guardLoopback(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// A browser sends Origin on every fetch it makes, so rejecting the
		// header outright locked out the harness's own web UI along with
		// everything else. What the guard is actually for is DNS rebinding: a
		// page on evil.com that resolves to 127.0.0.1. That page carries
		// Origin: http://evil.com, which is not a loopback origin and is still
		// refused here — and its Host header is not loopback either, so the
		// check below catches it a second time.
		if origin := r.Header.Get("Origin"); origin != "" && !isLoopbackOrigin(origin) {
			http.Error(w, "cross-origin requests are not accepted", http.StatusForbidden)
			return
		}
		if !isLoopbackHost(r.Host) {
			http.Error(w, "host must be the loopback interface", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// isLoopbackOrigin reports whether an Origin header names this machine over
// plain HTTP. Only http:// is accepted, and only a loopback host: an https
// origin cannot be this server (it does not serve TLS), and anything else is
// somebody else's page.
func isLoopbackOrigin(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "http" || u.Host == "" {
		return false
	}
	// A URL with a path, query or credentials is not a well-formed Origin;
	// treating one as valid would accept "http://127.0.0.1@evil.com".
	if u.Path != "" || u.RawQuery != "" || u.User != nil {
		return false
	}
	return isLoopbackHost(u.Host)
}

// isLoopbackHost reports whether a Host header names the local machine.
// The port is optional, and a bare IPv6 literal may arrive without brackets.
func isLoopbackHost(host string) bool {
	if host == "" {
		return false
	}
	name := host
	if h, _, err := net.SplitHostPort(host); err == nil {
		name = h
	}
	name = strings.TrimSuffix(strings.TrimPrefix(name, "["), "]")
	if strings.EqualFold(name, "localhost") {
		return true
	}
	if ip := net.ParseIP(name); ip != nil {
		return ip.IsLoopback()
	}
	return false
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// cancelTaskHandler serves POST /v1/tasks/{id}/cancel.
//
// Cancellation is addressed by task id because the socket that started a run is
// not a usable handle: POST /v1/tasks does not return until the task is over,
// so the only way to "cancel" was to drop the request carrying the result. A
// client watching /v1/events has the id from task.created, and so does a second
// client that reconnected after a refresh.
func cancelTaskHandler(rt *runtime.Runtime) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, action, ok := strings.Cut(strings.TrimPrefix(r.URL.Path, "/v1/tasks/"), "/")
		if !ok || action != "cancel" {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		// 404 rather than a cheerful 200: a client that cancels a task which
		// already finished, or mistypes an id, has to be able to tell.
		if !rt.CancelTask(id) {
			writeJSON(w, http.StatusNotFound, map[string]any{
				"taskId": id, "cancelled": false, "error": "no such running task",
			})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"taskId": id, "cancelled": true})
	}
}
