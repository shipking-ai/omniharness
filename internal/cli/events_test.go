package cli

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"omniharness/internal/event"
)

// readSSE opens the handler against a live server and returns a reader over the
// stream plus a stop function. httptest.NewRecorder cannot be used here: it
// buffers the whole response, so a handler that never returns would never be
// observed at all.
func readSSE(t *testing.T, bus *event.Bus, query string) (*bufio.Reader, func()) {
	t.Helper()
	srv := httptest.NewServer(eventStreamHandler(bus))
	ctx, cancel := context.WithCancel(context.Background())
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+query, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if got := resp.Header.Get("Content-Type"); got != "text/event-stream" {
		t.Fatalf("Content-Type = %q, want text/event-stream", got)
	}
	return bufio.NewReader(resp.Body), func() {
		cancel()
		resp.Body.Close()
		srv.Close()
	}
}

// readFrame reads SSE lines until a blank line ends the frame. It fails rather
// than hanging, so a stream that stops producing is a test failure with a
// message instead of a timeout with none.
func readFrame(t *testing.T, r *bufio.Reader) map[string]string {
	t.Helper()
	frame := map[string]string{}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				return
			}
			line = strings.TrimRight(line, "\r\n")
			if line == "" {
				if len(frame) > 0 {
					return
				}
				continue // the blank line after a ping comment
			}
			if strings.HasPrefix(line, ":") {
				continue // comment / ping
			}
			if key, value, ok := strings.Cut(line, ": "); ok {
				frame[key] = value
			}
		}
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("no SSE frame arrived within 5s")
	}
	return frame
}

// The headers must be committed before the first event. A client that waits
// for the response before subscribing would otherwise block until something
// happens on the harness, which on an idle server is never — and that is the
// normal case, since you open the stream and then start a task.
func TestEventStreamCommitsHeadersBeforeAnyEvent(t *testing.T) {
	bus := event.NewBus()
	defer bus.Close()
	srv := httptest.NewServer(eventStreamHandler(bus))
	defer srv.Close()

	// ResponseHeaderTimeout is the assertion. Without the explicit flush the
	// headers still arrive — on the first ping, twenty seconds later — so a
	// test that merely waits for them passes on the broken version and only
	// looks slow. Two seconds is far outside any local scheduling jitter and
	// far inside the ping interval.
	client := &http.Client{Transport: &http.Transport{ResponseHeaderTimeout: 2 * time.Second}}
	defer client.CloseIdleConnections()

	resp, err := client.Get(srv.URL)
	if err != nil {
		t.Fatalf("no response headers within 2s on an idle stream: %v", err)
	}
	defer resp.Body.Close()
	if got := resp.Header.Get("Content-Type"); got != "text/event-stream" {
		t.Fatalf("Content-Type = %q, want text/event-stream", got)
	}
}

func TestEventStreamDeliversPublishedEvents(t *testing.T) {
	bus := event.NewBus()
	defer bus.Close()
	reader, stop := readSSE(t, bus, "")
	defer stop()

	// Give the handler a moment to subscribe: an event published before the
	// subscription exists is delivered to nobody.
	time.Sleep(150 * time.Millisecond)
	bus.Publish(event.New(&event.LogMessageData{Message: "hello from the bus"}))

	frame := readFrame(t, reader)
	if !strings.Contains(frame["data"], "hello from the bus") {
		t.Fatalf("data = %q, want the published payload", frame["data"])
	}
	if frame["event"] == "" {
		t.Error("no event field; a client cannot dispatch on type")
	}
	if frame["id"] == "" || frame["id"] == "0" {
		t.Errorf("id = %q, want the bus sequence so a client can detect drops", frame["id"])
	}
}

// The whole point of surfacing Seq: it is deliberately not in the JSON, so
// without the SSE id a client has no way to notice it missed anything.
func TestEventStreamIdCarriesTheBusSequence(t *testing.T) {
	bus := event.NewBus()
	defer bus.Close()
	reader, stop := readSSE(t, bus, "")
	defer stop()
	time.Sleep(150 * time.Millisecond)

	bus.Publish(event.New(&event.LogMessageData{Message: "first"}))
	bus.Publish(event.New(&event.LogMessageData{Message: "second"}))

	first, second := readFrame(t, reader), readFrame(t, reader)
	if first["id"] == second["id"] {
		t.Fatalf("both frames carry id %q; the sequence is not advancing", first["id"])
	}
	if strings.Contains(first["data"], "\"Seq\"") || strings.Contains(first["data"], "\"seq\"") {
		t.Error("Seq leaked into the JSON body; it is process-local and marked json:\"-\"")
	}
}

// Without this a browser tab showing one session would render every other
// session's traffic into it.
func TestEventStreamSessionFilter(t *testing.T) {
	bus := event.NewBus()
	defer bus.Close()
	reader, stop := readSSE(t, bus, "?session=wanted")
	defer stop()
	time.Sleep(150 * time.Millisecond)

	other := event.New(&event.LogMessageData{Message: "from another session"})
	other.SessionID = "unwanted"
	bus.Publish(other)

	mine := event.New(&event.LogMessageData{Message: "from my session"})
	mine.SessionID = "wanted"
	bus.Publish(mine)

	frame := readFrame(t, reader)
	if strings.Contains(frame["data"], "another session") {
		t.Fatal("an event from a different session was delivered through the filter")
	}
	if !strings.Contains(frame["data"], "from my session") {
		t.Fatalf("data = %q, want the matching session's event", frame["data"])
	}
}

func TestEventStreamRejectsNonGet(t *testing.T) {
	bus := event.NewBus()
	defer bus.Close()
	rec := httptest.NewRecorder()
	eventStreamHandler(bus)(rec, httptest.NewRequest(http.MethodPost, "/v1/events", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST /v1/events = %d, want 405", rec.Code)
	}
}

// A disconnected client must release its bus subscription. Before the context
// case existed the handler sat on a dead connection until the process ended,
// and every reconnect leaked another subscriber that the bus kept fanning
// events into.
func TestEventStreamUnsubscribesWhenTheClientLeaves(t *testing.T) {
	bus := event.NewBus()
	defer bus.Close()
	if n := bus.Len(); n != 0 {
		t.Fatalf("bus starts with %d subscribers", n)
	}
	reader, stop := readSSE(t, bus, "")
	time.Sleep(150 * time.Millisecond)
	if n := bus.Len(); n != 1 {
		t.Fatalf("subscribers = %d after connecting, want 1", n)
	}
	// Publish so the handler is inside a write when the client goes away —
	// the case that actually happens when a browser tab closes mid-run.
	bus.Publish(event.New(&event.LogMessageData{Message: "before disconnect"}))
	readFrame(t, reader)
	stop()

	deadline := time.Now().Add(5 * time.Second)
	for bus.Len() != 0 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if n := bus.Len(); n != 0 {
		t.Fatalf("subscribers = %d after the client left, want 0; the subscription leaked", n)
	}
}

func TestParseEventTypes(t *testing.T) {
	if got := parseEventTypes(""); got != nil {
		t.Errorf("parseEventTypes(\"\") = %v, want nil so the caller subscribes to everything", got)
	}
	// An empty entry must not become a subscription to the event type "",
	// which would filter out every real event and deliver nothing.
	got := parseEventTypes("task.started, ,task.completed")
	if len(got) != 2 || got[0] != "task.started" || got[1] != "task.completed" {
		t.Errorf("parseEventTypes = %v, want the two named types", got)
	}
}
