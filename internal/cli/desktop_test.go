package cli

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// --app is the whole difference between a desktop window and a browser tab, and
// the separate profile is what keeps the harness out of the user's own browser
// session. Both are easy to drop in a refactor and neither fails loudly.
func TestDesktopArgsOpenAWindowWithItsOwnProfile(t *testing.T) {
	args := desktopArgs("http://127.0.0.1:20140/", `C:\profile dir`, 1280, 860)
	joined := strings.Join(args, "\n")

	if !strings.Contains(joined, "--app=http://127.0.0.1:20140/") {
		t.Error("no --app: this would open a tab in the user's browser, not a window")
	}
	if !strings.Contains(joined, `--user-data-dir=C:\profile dir`) {
		t.Error("no separate --user-data-dir: the window would inherit the user's cookies and extensions")
	}
	if !strings.Contains(joined, "--window-size=1280,860") {
		t.Errorf("window size missing: %v", args)
	}
	// Each argument is passed as its own element, so a profile path containing
	// a space cannot split into two arguments.
	var found bool
	for _, a := range args {
		if a == `--user-data-dir=C:\profile dir` {
			found = true
		}
	}
	if !found {
		t.Error("the profile path was not passed as a single argument")
	}
}

// Firefox and Safari have no --app, so offering them would open a tabbed
// window and call it a desktop app.
func TestDesktopOnlyConsidersBrowsersWithAppMode(t *testing.T) {
	for _, c := range browserCandidates() {
		lower := strings.ToLower(c)
		if strings.Contains(lower, "firefox") || strings.Contains(lower, "safari") {
			t.Errorf("candidate %q has no app mode", c)
		}
	}
	if len(browserCandidates()) == 0 {
		t.Error("no candidates for this platform")
	}
}

func TestWaitForServerReturnsOnceItAnswers(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	if err := waitForServer(context.Background(), srv.URL+"/", 5*time.Second); err != nil {
		t.Fatalf("waitForServer: %v", err)
	}
}

// The window must never be opened on a connection-refused page, so a server
// that never arrives has to surface as an error rather than a blank window.
func TestWaitForServerGivesUp(t *testing.T) {
	start := time.Now()
	// Port 1 on loopback: reserved, and nothing will be listening.
	err := waitForServer(context.Background(), "http://127.0.0.1:1/", 400*time.Millisecond)
	if err == nil {
		t.Fatal("waitForServer succeeded against a port with nothing on it")
	}
	if time.Since(start) > 5*time.Second {
		t.Errorf("took %s to give up on a 400ms timeout", time.Since(start))
	}
}

func TestWaitForServerHonoursCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- waitForServer(ctx, "http://127.0.0.1:1/", time.Minute) }()
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Error("a cancelled wait returned no error")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("waitForServer ignored cancellation")
	}
}
