package diagnose

import (
	"testing"

	"omniharness/internal/event"
)

// trajectory builds a recorded run from payloads, the way the store hands one
// back.
func trajectory(payloads ...event.Payload) []event.Event {
	out := make([]event.Event, 0, len(payloads))
	for _, p := range payloads {
		out = append(out, event.New(p))
	}
	return out
}

func ruleAt(t *testing.T, r Report, rule Rule) Finding {
	t.Helper()
	for _, f := range r.Findings {
		if f.Rule == rule {
			return f
		}
	}
	t.Fatalf("no %s finding in %+v", rule, r.Findings)
	return Finding{}
}

func hasRule(r Report, rule Rule) bool {
	for _, f := range r.Findings {
		if f.Rule == rule {
			return true
		}
	}
	return false
}

// --- 1. the loop ------------------------------------------------------------

// A read is deterministic. Asking it a third time with the same arguments
// cannot teach the model anything the first answer did not already carry, so
// the agent is circling rather than working.
func TestRepeatedIdenticalCallIsALoop(t *testing.T) {
	read := &event.ToolRequestedData{Tool: "read_file", Input: `{"path":"main.go"}`, Risk: "low"}
	events := trajectory(
		&event.ToolRequestedData{Tool: "search", Input: `{"q":"parse"}`, Risk: "low"},
		read, read, read,
	)
	r := Run(events, Thresholds{})

	f := ruleAt(t, r, RuleRepeatedCall)
	if f.Count != 3 {
		t.Fatalf("count = %d, want 3", f.Count)
	}
	// The step is the onset — where it started, not where it was noticed.
	if f.Step != 1 {
		t.Fatalf("step = %d, want the first of the three (1)", f.Step)
	}
	if f.Severity != SeverityWaste {
		t.Fatalf("severity = %q", f.Severity)
	}
}

// Same tool, different arguments, is work.
func TestSameToolWithDifferentArgumentsIsNotALoop(t *testing.T) {
	events := trajectory(
		&event.ToolRequestedData{Tool: "read_file", Input: `{"path":"a.go"}`, Risk: "low"},
		&event.ToolRequestedData{Tool: "read_file", Input: `{"path":"b.go"}`, Risk: "low"},
		&event.ToolRequestedData{Tool: "read_file", Input: `{"path":"c.go"}`, Risk: "low"},
		&event.ToolRequestedData{Tool: "read_file", Input: `{"path":"d.go"}`, Risk: "low"},
	)
	if r := Run(events, Thresholds{}); hasRule(r, RuleRepeatedCall) {
		t.Fatalf("reading four different files is not a loop: %+v", r.Findings)
	}
}

// Looking twice is ordinary — the agent looked, did something else, came back.
func TestTwoIdenticalCallsAreNotYetALoop(t *testing.T) {
	read := &event.ToolRequestedData{Tool: "read_file", Input: `{"path":"main.go"}`, Risk: "low"}
	if r := Run(trajectory(read, read), Thresholds{}); hasRule(r, RuleRepeatedCall) {
		t.Fatalf("two identical reads should be forgiven: %+v", r.Findings)
	}
}

// --- 2. thrashing -----------------------------------------------------------

func TestConsecutiveFailuresOfOneToolAreThrash(t *testing.T) {
	fail := &event.ToolFailedData{Tool: "run_command", Status: "failed", Error: "exit 1"}
	r := Run(trajectory(fail, fail, fail), Thresholds{})

	f := ruleAt(t, r, RuleToolThrash)
	if f.Count != 3 {
		t.Fatalf("count = %d, want 3", f.Count)
	}
	if f.Step != 0 {
		t.Fatalf("step = %d, want the first failure", f.Step)
	}
}

// A tool that fails, works, and fails again is two incidents, not a loop —
// something changed in between, which is exactly what a retry is for.
func TestFailureSeparatedBySuccessIsNotThrash(t *testing.T) {
	events := trajectory(
		&event.ToolFailedData{Tool: "run_command", Status: "failed"},
		&event.ToolFailedData{Tool: "run_command", Status: "failed"},
		&event.ToolFinishedData{Tool: "run_command", Status: "completed"},
		&event.ToolFailedData{Tool: "run_command", Status: "failed"},
	)
	if r := Run(events, Thresholds{}); hasRule(r, RuleToolThrash) {
		t.Fatalf("a success in the middle breaks the run: %+v", r.Findings)
	}
}

// --- 3. unverified completion ----------------------------------------------

func TestCompletionWithNoEvaluationIsReported(t *testing.T) {
	events := trajectory(
		&event.ToolRequestedData{Tool: "write_file", Input: `{"path":"a.go"}`, Risk: "medium"},
		&event.ToolFinishedData{Tool: "write_file", Status: "completed"},
		&event.TaskCompletedData{Summary: "done"},
	)

	f := ruleAt(t, Run(events, Thresholds{}), RuleUnverified)
	if f.Step != 2 {
		t.Fatalf("the finding belongs at the moment the claim was made, got step %d", f.Step)
	}
}

// A run that read some files and answered has nothing to verify. Flagging it
// would fire this rule on most sessions, and a diagnostic that cries wolf on
// every clean run is one nobody reads.
func TestReadOnlyCompletionIsNotFlagged(t *testing.T) {
	events := trajectory(
		&event.ToolRequestedData{Tool: "read_file", Input: `{"path":"a.go"}`, Risk: "low"},
		&event.ToolFinishedData{Tool: "read_file", Status: "completed"},
		&event.TaskCompletedData{Summary: "the parser is in lex.go"},
	)
	if r := Run(events, Thresholds{}); hasRule(r, RuleUnverified) {
		t.Fatalf("nothing was changed, so there is nothing to verify: %+v", r.Findings)
	}
}

// A write that was requested and refused changed nothing either.
func TestDeniedWriteDoesNotCountAsWork(t *testing.T) {
	events := trajectory(
		&event.ToolRequestedData{Tool: "write_file", Input: `{"path":"a.go"}`, Risk: "medium"},
		&event.ToolFinishedData{Tool: "write_file", Status: "denied"},
		&event.TaskCompletedData{Summary: "blocked"},
	)
	if r := Run(events, Thresholds{}); hasRule(r, RuleUnverified) {
		t.Fatalf("a denied write is not unverified work: %+v", r.Findings)
	}
}

func TestCompletionAfterEvaluationIsClean(t *testing.T) {
	events := trajectory(
		&event.EvaluationCompletedData{Evaluator: "test", Outcome: "PASS"},
		&event.TaskCompletedData{Summary: "done"},
	)

	if r := Run(events, Thresholds{}); hasRule(r, RuleUnverified) {
		t.Fatalf("the work was checked: %+v", r.Findings)
	}
}

// --- 4. the boundary --------------------------------------------------------

// The rule an outcome check cannot replace: the answer can be perfectly good
// and this still be a breach of the boundary the harness promised to hold.
func TestHighRiskToolRunningWithoutApprovalIsABreach(t *testing.T) {
	events := trajectory(
		&event.ToolRequestedData{Tool: "run_command", Input: `{"command":"rm"}`, Risk: "high"},
		&event.ToolStartedData{Tool: "run_command"},
	)
	r := Run(events, Thresholds{})

	f := ruleAt(t, r, RuleUnapprovedRisk)
	if f.Severity != SeverityBreach {
		t.Fatalf("severity = %q, want breach", f.Severity)
	}
	if r.Breaches() != 1 {
		t.Fatalf("breaches = %d, want 1", r.Breaches())
	}
	// The summary has to name the step the call was requested at, because that
	// is where a reader goes to see what was asked for.
	if got := f.Summary; got == "" || !contains(got, "step 0") {
		t.Fatalf("summary should locate the request: %q", got)
	}
}

func TestApprovedHighRiskToolIsClean(t *testing.T) {
	events := trajectory(
		&event.ToolRequestedData{Tool: "run_command", Input: `{"command":"rm"}`, Risk: "high"},
		&event.ApprovalGrantedData{Tool: "run_command", Decision: "granted"},
		&event.ToolStartedData{Tool: "run_command"},
	)
	r := Run(events, Thresholds{})
	if hasRule(r, RuleUnapprovedRisk) {
		t.Fatalf("approval was granted: %+v", r.Findings)
	}
	if r.Breaches() != 0 {
		t.Fatalf("breaches = %d, want 0", r.Breaches())
	}
}

// Low-risk work does not need a human and must not be reported as though it
// did — a diagnostic that cries wolf on every read is one nobody reads.
func TestLowRiskToolNeedsNoApproval(t *testing.T) {
	events := trajectory(
		&event.ToolRequestedData{Tool: "read_file", Input: `{"path":"a"}`, Risk: "low"},
		&event.ToolStartedData{Tool: "read_file"},
	)
	if r := Run(events, Thresholds{}); hasRule(r, RuleUnapprovedRisk) {
		t.Fatalf("a read needs no approval: %+v", r.Findings)
	}
}

// --- 5. onset and ordering --------------------------------------------------

// The step number is the whole reason to read a trajectory instead of an
// outcome, so the first finding has to be the earliest one.
func TestFindingsAreOrderedByOnset(t *testing.T) {
	read := &event.ToolRequestedData{Tool: "read_file", Input: `{"path":"a"}`, Risk: "low"}
	fail := &event.ToolFailedData{Tool: "run_command", Status: "failed"}
	events := trajectory(
		read, read, read, // loop begins at 0
		fail, fail, fail, // thrash begins at 3
	)
	r := Run(events, Thresholds{})

	if len(r.Findings) < 2 {
		t.Fatalf("expected both findings, got %+v", r.Findings)
	}
	if r.Findings[0].Step > r.Findings[1].Step {
		t.Fatalf("findings out of trajectory order: %+v", r.Findings)
	}
	onset, ok := r.Onset()
	if !ok || onset != 0 {
		t.Fatalf("onset = %d, %v; want 0, true", onset, ok)
	}
}

// A clean run has no onset at all, which is not the same as an onset of zero.
func TestCleanRunHasNoOnset(t *testing.T) {
	r := Run(trajectory(&event.ToolRequestedData{Tool: "read_file", Input: `{"path":"a"}`, Risk: "low"}), Thresholds{})
	if len(r.Findings) != 0 {
		t.Fatalf("expected a clean report, got %+v", r.Findings)
	}
	if _, ok := r.Onset(); ok {
		t.Fatal("a clean run must report no onset rather than step zero")
	}
}

// The same trajectory must produce the same report every time. Map iteration
// is not ordered, and a report that reshuffles itself cannot be diffed between
// two runs — which is the only thing a regression gate does with it.
func TestReportIsStableAcrossRuns(t *testing.T) {
	var payloads []event.Payload
	for _, tool := range []string{"alpha", "beta", "gamma", "delta"} {
		f := &event.ToolFailedData{Tool: tool, Status: "failed"}
		payloads = append(payloads, f, f, f)
	}
	events := trajectory(payloads...)

	first := Run(events, Thresholds{})
	for i := 0; i < 20; i++ {
		got := Run(events, Thresholds{})
		if len(got.Findings) != len(first.Findings) {
			t.Fatalf("finding count changed between runs: %d vs %d", len(got.Findings), len(first.Findings))
		}
		for j := range got.Findings {
			if got.Findings[j].Rule != first.Findings[j].Rule || got.Findings[j].Step != first.Findings[j].Step {
				t.Fatalf("report reordered on run %d:\n%+v\n%+v", i, first.Findings, got.Findings)
			}
		}
	}
}

// An event this cannot decode is skipped, never guessed at. A harness grows
// event types, and a diagnostic that invented a finding from a payload it did
// not understand would be worse than one that stayed quiet.
func TestUnknownEventsAreSkipped(t *testing.T) {
	events := []event.Event{
		{Type: event.Type("something.new"), Data: []byte(`{"whatever":1}`)},
		{Type: event.Type("also.new")},
	}
	r := Run(events, Thresholds{})
	if len(r.Findings) != 0 {
		t.Fatalf("expected nothing from undecodable events, got %+v", r.Findings)
	}
	if r.Steps != 2 {
		t.Fatalf("steps = %d, want 2 — they are still steps", r.Steps)
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (func() bool {
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	})()
}
