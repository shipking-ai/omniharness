package cli

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestIsLoopbackHost(t *testing.T) {
	allowed := []string{
		"localhost", "localhost:20140", "LOCALHOST:20140",
		"127.0.0.1", "127.0.0.1:20140", "127.0.0.5:20140",
		"[::1]:20140", "::1",
	}
	for _, host := range allowed {
		if !isLoopbackHost(host) {
			t.Errorf("isLoopbackHost(%q) = false, want true", host)
		}
	}

	// A rebound request carries the attacker's hostname, because that is what
	// the browser resolved — this is the case the guard exists for.
	denied := []string{
		"", "evil.example.com", "evil.example.com:20140",
		"omniharness.localhost.evil.com", "10.0.0.5:20140", "example.com",
	}
	for _, host := range denied {
		if isLoopbackHost(host) {
			t.Errorf("isLoopbackHost(%q) = true, want false", host)
		}
	}
}

func TestGuardLoopback(t *testing.T) {
	reached := false
	guarded := guardLoopback(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		reached = true
		w.WriteHeader(http.StatusOK)
	}))

	call := func(host, origin string) int {
		reached = false
		req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:20140/health", nil)
		req.Host = host
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		rec := httptest.NewRecorder()
		guarded.ServeHTTP(rec, req)
		return rec.Code
	}

	// A local client: no Origin, loopback Host.
	if code := call("127.0.0.1:20140", ""); code != http.StatusOK || !reached {
		t.Fatalf("loopback request: code=%d reached=%v, want 200 and reached", code, reached)
	}
	if code := call("localhost:20140", ""); code != http.StatusOK {
		t.Fatalf("localhost request: code=%d, want 200", code)
	}

	// DNS rebinding: the socket is loopback but the Host is the attacker's.
	if code := call("evil.example.com:20140", ""); code != http.StatusForbidden {
		t.Fatalf("rebound host: code=%d, want 403", code)
	}
	if reached {
		t.Fatal("a rebound request must not reach the handler")
	}

	// Any browser-issued cross-origin request, even to a loopback Host.
	if code := call("127.0.0.1:20140", "https://evil.example.com"); code != http.StatusForbidden {
		t.Fatalf("cross-origin: code=%d, want 403", code)
	}
	if reached {
		t.Fatal("a cross-origin request must not reach the handler")
	}
}

// The guard used to refuse any request carrying an Origin, which locked out
// the harness's own web UI: a browser attaches Origin to every fetch it makes.
// What the guard is for is DNS rebinding, and a rebound page carries the
// attacker's origin, not a loopback one.
func TestIsLoopbackOrigin(t *testing.T) {
	for _, origin := range []string{
		"http://localhost", "http://localhost:20140", "http://LOCALHOST:20140",
		"http://127.0.0.1:20140", "http://127.0.0.5:20140", "http://[::1]:20140",
	} {
		if !isLoopbackOrigin(origin) {
			t.Errorf("isLoopbackOrigin(%q) = false, want true", origin)
		}
	}

	for _, origin := range []string{
		"", "null", "evil.example.com", "http://evil.example.com",
		"http://omniharness.localhost.evil.com", "http://10.0.0.5:20140",
		// https cannot be this server: it does not serve TLS, so an https
		// origin claiming to be localhost is somebody else's page.
		"https://127.0.0.1:20140",
		// Userinfo is the classic trick — the real host here is evil.com.
		"http://127.0.0.1@evil.com",
		// A well-formed Origin has no path or query; accepting one widens the
		// parse surface for no reason.
		"http://127.0.0.1:20140/x", "http://127.0.0.1:20140?a=b",
		"file://", "chrome-extension://abcdef",
	} {
		if isLoopbackOrigin(origin) {
			t.Errorf("isLoopbackOrigin(%q) = true, want false", origin)
		}
	}
}

// End to end through the guard: the harness's own UI gets through, a rebound
// page does not.
func TestGuardAllowsTheLocalUIAndStillBlocksRebinding(t *testing.T) {
	guarded := guardLoopback(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	call := func(host, origin string) int {
		req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:20140/v1/tasks", nil)
		req.Host = host
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		rec := httptest.NewRecorder()
		guarded.ServeHTTP(rec, req)
		return rec.Code
	}
	if code := call("127.0.0.1:20140", "http://127.0.0.1:20140"); code != http.StatusOK {
		t.Errorf("the local UI was refused: %d", code)
	}
	if code := call("localhost:20140", "http://localhost:20140"); code != http.StatusOK {
		t.Errorf("the local UI on localhost was refused: %d", code)
	}
	// DNS rebinding: the browser resolved evil.com to 127.0.0.1, so the request
	// arrives here — carrying the attacker's origin.
	if code := call("127.0.0.1:20140", "http://evil.example.com"); code != http.StatusForbidden {
		t.Errorf("a rebound request was accepted: %d", code)
	}
	if code := call("evil.example.com", "http://evil.example.com"); code != http.StatusForbidden {
		t.Errorf("a rebound request was accepted: %d", code)
	}
}
