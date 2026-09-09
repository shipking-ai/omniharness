package cli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"omniharness/internal/config"
	"omniharness/internal/runtime"
	"omniharness/internal/testutil"
)

func cancelRuntime(t *testing.T) *runtime.Runtime {
	t.Helper()
	cfg := config.Default()
	cfg.Persistence.Dir = t.TempDir()
	fake := testutil.NewFakeOmniRoute(t, testutil.FakeStep{Content: "ok"})
	rt, err := runtime.New(cfg, runtime.Options{Gateway: fake.Client()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(rt.Close)
	return rt
}

func call(t *testing.T, rt *runtime.Runtime, method, path string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	cancelTaskHandler(rt)(rec, httptest.NewRequest(method, path, nil))
	return rec
}

// A task that is not running must not report as cancelled, or a client cannot
// tell a real cancel from a typo or a run that already finished.
func TestCancelUnknownTaskIs404(t *testing.T) {
	rt := cancelRuntime(t)
	rec := call(t, rt, http.MethodPost, "/v1/tasks/does-not-exist/cancel")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	var body struct {
		TaskID    string `json:"taskId"`
		Cancelled bool   `json:"cancelled"`
		Error     string `json:"error"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Cancelled {
		t.Error("cancelled = true for a task that was never running")
	}
	if body.TaskID != "does-not-exist" || body.Error == "" {
		t.Errorf("body = %+v, want the id echoed and a reason", body)
	}
}

// GET must not cancel anything: cancelling is a state change, and a link
// preview or a curl typo should not stop a running task.
func TestCancelRejectsNonPost(t *testing.T) {
	rt := cancelRuntime(t)
	if rec := call(t, rt, http.MethodGet, "/v1/tasks/abc/cancel"); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET status = %d, want 405", rec.Code)
	}
	if rec := call(t, rt, http.MethodDelete, "/v1/tasks/abc/cancel"); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("DELETE status = %d, want 405", rec.Code)
	}
}

// The path pattern is registered as a prefix, so anything under /v1/tasks/
// reaches this handler and it has to reject what it does not serve rather than
// treating a stray segment as an id.
func TestCancelIgnoresOtherPathsUnderTasks(t *testing.T) {
	rt := cancelRuntime(t)
	for _, path := range []string{
		"/v1/tasks/abc",           // no action
		"/v1/tasks/abc/status",    // wrong action
		"/v1/tasks/abc/cancel/xx", // trailing junk
		"/v1/tasks/",              // no id at all
	} {
		rec := call(t, rt, http.MethodPost, path)
		if rec.Code != http.StatusNotFound {
			t.Errorf("POST %s = %d, want 404", path, rec.Code)
		}
		// Both rejections are 404, so the status code alone proves nothing —
		// an unknown id is also 404. The distinguishing fact is that the path
		// was never treated as a cancel at all, so no cancel payload is
		// produced. Without this the test passed against a handler that
		// matched every path under /v1/tasks/.
		if body := rec.Body.String(); strings.Contains(body, "cancelled") {
			t.Errorf("POST %s produced a cancel response (%s); the path was treated as a cancel", path, strings.TrimSpace(body))
		}
	}
}
