package cli

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"omniharness/internal/diagnose"
	"omniharness/internal/gateway"
	"omniharness/internal/testutil"
)

func readCall(id, path string) gateway.ToolCall {
	c := gateway.ToolCall{ID: id, Type: "function"}
	c.Function.Name = "read_file"
	c.Function.Arguments = `{"path":"` + path + `"}`
	return c
}

// The whole point of the trajectory work: a run can circle and the outcome
// cannot say so. This drives a real run through the real runtime with a
// gateway that keeps asking for the same file, then asks the shipped command
// what happened.
func TestDiagnoseFindsALoopInARealRun(t *testing.T) {
	dir := t.TempDir()
	testutil.InitFakeWorkspace(t, dir)
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# project\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// The fake repeats its last step, so a single read request becomes an
	// agent that reads the same file with the same arguments until the turn
	// cap stops it — which is exactly the shape being detected.
	fake := testutil.NewFakeOmniRoute(t,
		testutil.FakeStep{ToolCalls: []gateway.ToolCall{readCall("c1", "README.md")}},
	)
	t.Setenv("OMNIHARNESS_DATA_DIR", dir)
	t.Setenv("OMNIHARNESS_WORKSPACE", dir)
	t.Setenv("OMNIHARNESS_ENDPOINT", fake.URL())

	_ = captureStderr(t, func() {})
	run := NewRootCmd()
	run.SetArgs([]string{"run", "check the readme", "--headless", "--json"})
	_ = captureStderr(t, func() {
		_ = captureStdout(t, func() { _ = run.Execute() })
	})
	// The run itself is expected to end badly — an agent that reads the same
	// file forever runs out of turns — which is the situation this command
	// exists for, so the session is found rather than parsed off a result.
	sessionID := latestSession(t)

	diag := NewRootCmd()
	diag.SetArgs([]string{"diagnose", sessionID, "--json"})
	var out string
	_ = captureStderr(t, func() {
		out = captureStdout(t, func() {
			if err := diag.Execute(); err != nil {
				t.Errorf("diagnose failed: %v", err)
			}
		})
	})

	var report diagnose.Report
	if err := json.Unmarshal([]byte(out), &report); err != nil {
		t.Fatalf("diagnose did not emit a report: %v\n%s", err, out)
	}
	if report.Steps == 0 {
		t.Fatal("the session recorded no steps — the trajectory never reached the store")
	}
	var loop *diagnose.Finding
	for i := range report.Findings {
		if report.Findings[i].Rule == diagnose.RuleRepeatedCall {
			loop = &report.Findings[i]
		}
	}
	if loop == nil {
		t.Fatalf("a run that read one file over and over went unflagged:\n%s", out)
	}
	if loop.Count < 3 {
		t.Fatalf("count = %d, want at least 3", loop.Count)
	}
	if !strings.Contains(loop.Summary, "read_file") {
		t.Fatalf("summary should name the tool: %q", loop.Summary)
	}
	// The onset is what a person opens this for.
	if onset, ok := report.Onset(); !ok || onset < 0 || onset >= report.Steps {
		t.Fatalf("onset %d is not a step in a %d-step run", onset, report.Steps)
	}
}

// A run that does its work once must come back clean, or the diagnostic is
// noise and nobody will read it.
func TestDiagnoseIsQuietOnAStraightRun(t *testing.T) {
	fake := testutil.NewFakeOmniRoute(t, testutil.FakeStep{Content: "all done"})
	dir := t.TempDir()
	testutil.InitFakeWorkspace(t, dir)
	t.Setenv("OMNIHARNESS_DATA_DIR", dir)
	t.Setenv("OMNIHARNESS_WORKSPACE", dir)
	t.Setenv("OMNIHARNESS_ENDPOINT", fake.URL())

	_ = captureStderr(t, func() {})
	run := NewRootCmd()
	run.SetArgs([]string{"run", "say done", "--headless", "--json"})
	_ = captureStderr(t, func() {
		_ = captureStdout(t, func() { _ = run.Execute() })
	})

	diag := NewRootCmd()
	diag.SetArgs([]string{"diagnose", latestSession(t), "--strict"})
	var out string
	_ = captureStderr(t, func() {
		out = captureStdout(t, func() {
			// --strict must not fail a clean run.
			if err := diag.Execute(); err != nil {
				t.Errorf("a clean run failed --strict: %v", err)
			}
		})
	})
	if !strings.Contains(out, "nothing flagged") {
		t.Fatalf("expected a clean report, got:\n%s", out)
	}
}

// latestSession is the run that just happened. Each of these tests uses its
// own data directory, so "most recent" is unambiguous.
func latestSession(t *testing.T) string {
	t.Helper()
	rt, err := newRuntime(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	sessions, err := rt.ListSessions(1)
	if err != nil || len(sessions) == 0 {
		t.Fatalf("the run recorded no session: %v", err)
	}
	return sessions[0].ID
}
