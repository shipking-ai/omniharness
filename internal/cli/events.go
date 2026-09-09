package cli

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"omniharness/internal/event"
)

// eventStreamBuffer is the per-subscriber queue depth. The bus never blocks a
// publisher: when a subscriber falls behind it drops that subscriber's oldest
// event and keeps going. 1024 matches what the runtime's own persister takes,
// which is the busiest consumer in the process.
const eventStreamBuffer = 1024

// eventStreamPing is how often a comment line is written to an idle stream.
// A run can think for minutes without publishing anything; without traffic
// neither side learns the peer is gone, and the handler would sit on a dead
// connection holding a subscription until the server shut down.
const eventStreamPing = 20 * time.Second

// eventStreamHandler serves the live event stream as Server-Sent Events.
//
// Until this existed the HTTP API could start work and report it finished, and
// nothing in between: POST /v1/tasks runs the whole task and returns once, so a
// client watching a five-minute run saw an open socket and then a result. The
// event bus already carried everything the TUI draws — model calls, tool calls,
// approvals, evaluations — it simply had no way out of the process.
//
// SSE rather than a WebSocket because this is one-directional and the transport
// should not be a new dependency: it is a plain HTTP response that curl can
// read. The connection is subject to the same loopback guard as every other
// route, so a web page cannot open it through DNS rebinding.
//
// Delivery is lossy by design, and the id field is how a client finds out.
// Bus.Seq is a gapless publish counter, so a consumer that sees id jump from 41
// to 45 knows three events were dropped because it was too slow — and can go
// read the session over /v1/sessions/{id} to resynchronise. Losing events is
// preferable to the alternative: a subscriber that blocks the bus would stall
// the run itself.
func eventStreamHandler(bus *event.Bus) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		flusher, ok := w.(http.Flusher)
		if !ok {
			// Every net/http ResponseWriter flushes; this is here so the
			// failure is a clear message rather than a stream that buffers
			// forever behind some future wrapper.
			http.Error(w, "streaming unsupported by this server", http.StatusInternalServerError)
			return
		}

		session := strings.TrimSpace(r.URL.Query().Get("session"))
		types := parseEventTypes(r.URL.Query().Get("types"))

		var (
			ch     <-chan event.Event
			cancel func()
		)
		if len(types) > 0 {
			ch, cancel = bus.SubscribeTo(eventStreamBuffer, types...)
		} else {
			ch, cancel = bus.Subscribe(eventStreamBuffer)
		}
		defer cancel()

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Connection", "keep-alive")
		// Nothing should sniff or transform a stream that is read incrementally.
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.WriteHeader(http.StatusOK)
		// Commit the headers immediately. A client that waits for the response
		// before subscribing would otherwise hang until the first event, which
		// on an idle harness can be never.
		flusher.Flush()

		ping := time.NewTicker(eventStreamPing)
		defer ping.Stop()

		for {
			select {
			case <-r.Context().Done():
				return
			case <-ping.C:
				// A comment line: valid SSE, ignored by every client, and the
				// write is what surfaces a closed connection.
				if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
					return
				}
				flusher.Flush()
			case e, open := <-ch:
				if !open {
					return
				}
				// The session filter is applied here rather than at subscribe
				// time because the bus filters by type only, and a session id
				// is not known to it at all.
				if session != "" && e.SessionID != session {
					continue
				}
				payload, err := json.Marshal(e)
				if err != nil {
					// An event that cannot be encoded is skipped rather than
					// killing a stream that is otherwise healthy.
					continue
				}
				// id carries Seq, which is deliberately not part of the JSON
				// (it is process-local publish order, never persisted). SSE's
				// own id field is exactly the right place for it.
				if _, err := fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", e.Seq, e.Type, payload); err != nil {
					return
				}
				flusher.Flush()
			}
		}
	}
}

// parseEventTypes splits a comma-separated ?types= filter. Empty entries are
// dropped so "?types=" and "?types=a,,b" behave sensibly rather than
// subscribing to an event type named "".
func parseEventTypes(raw string) []event.Type {
	var out []event.Type
	for _, part := range strings.Split(raw, ",") {
		if part = strings.TrimSpace(part); part != "" {
			out = append(out, event.Type(part))
		}
	}
	return out
}
