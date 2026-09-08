package orchestrator

import (
	"context"
	"strings"
	"testing"

	"omniharness/internal/evaluate"
	"omniharness/internal/session"
	"omniharness/internal/strategy"
	"omniharness/internal/task"
	"omniharness/internal/testutil"
	"omniharness/internal/tools"
)

// stubExternalTool stands in for a configured provider. The creative plan's
// make step declares external_tool, and a step whose capability nothing
// provides fails before an agent ever runs — so without this the run would
// never reach the judgement these tests are about.
type stubExternalTool struct{}

func (stubExternalTool) Spec() tools.Spec {
	return tools.Spec{
		Name:         "stub_renderer",
		Description:  "renders a stub asset",
		Capabilities: []tools.Capability{"render_scene", tools.CapExternalTool},
	}
}

func (stubExternalTool) Run(context.Context, map[string]any) (tools.Result, error) {
	return tools.Result{Output: "rendered"}, nil
}

func creativeRun(t *testing.T, judgement string) (*task.Task, *session.Store) {
	t.Helper()
	dir := t.TempDir()
	fake := testutil.NewFakeOmniRoute(t, testutil.FakeStep{Content: judgement})
	o, store, _ := newOrchestrator(t, fake, dir)
	if err := o.deps.Tools.Register(stubExternalTool{}); err != nil {
		t.Fatal(err)
	}
	tsk, _ := runTask(t, o, "s1", task.Spec{
		Prompt: "Render the 3d scene with softer lighting and a lower camera angle, " +
			"then color grade the footage colder.",
		CWD: dir, SessionID: "s1",
	})
	if tsk == nil {
		t.Fatal("no task returned")
	}
	// Not asserted here: a run that fails verification has its strategy
	// re-selected by the repair loop, so the task's final Strategy is the
	// escalated one, not the plan that produced the judgement. The tests
	// below check the plan where it is still visible.
	return tsk, store
}

// verdictOutcome reports what the creative evaluator recorded, and fails if
// it never ran — without that check a test could pass because the task was
// routed somewhere else entirely.
func verdictOutcome(t *testing.T, store *session.Store, taskID string) string {
	t.Helper()
	evals, err := store.EvaluationsForTask(taskID)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range evals {
		if e.Evaluator == "creative-verdict" {
			return e.Outcome
		}
	}
	t.Fatal("the creative verdict evaluator never ran; this task did not take the creative path")
	return ""
}

// The bug this closes: a creative task matched no evaluator, so the
// orchestrator took "no evaluator applicable" as a pass. The director could
// look at the render, say it was wrong, and the run completed as a success
// with that rejection sitting in its own final output — brief/make/judge ran
// once and stopped regardless of the judgement.
func TestRejectedCreativeWorkDoesNotCompleteAsSuccess(t *testing.T) {
	tsk, store := creativeRun(t, "The title never appears and the key light is far too warm.\n"+
		"VERDICT: revise - add the title over the first two seconds and cool the key light")

	if tsk.Status == task.StatusCompleted {
		t.Fatalf("a rejected creative result completed as a success (error: %q)", tsk.Error)
	}
	if got := verdictOutcome(t, store, tsk.ID); got != "FAIL" {
		t.Fatalf("the director's rejection was recorded as %s", got)
	}
	// The director's objection has to reach the record, or a failed run says
	// nothing about what was wrong with the asset.
	if !strings.Contains(tsk.Error, "cool the key light") {
		t.Errorf("task error %q does not carry the director's objection", tsk.Error)
	}
	// And the rejection has to have driven another pass — that is what makes
	// the strategy an iteration rather than a single shot.
	if tsk.Repairs < 1 {
		t.Errorf("repairs = %d; the rejection did not cause another pass", tsk.Repairs)
	}
	agents, _ := store.AgentsForTask(tsk.ID)
	if len(agents) <= 3 {
		t.Errorf("%d agents ran; a three-step plan that re-ran should have more", len(agents))
	}
}

// The other half: approval must still finish, and must finish on the first
// pass. An evaluator that failed everything would be worse than none.
func TestApprovedCreativeWorkCompletesFirstTime(t *testing.T) {
	tsk, store := creativeRun(t, "Framing, lighting and the title all match the brief.\nVERDICT: approved")

	// The approved run never enters the repair loop, so this is the one place
	// the originally selected plan is still visible on the task.
	if tsk.Strategy != string(strategy.CreativeIterate) {
		t.Fatalf("strategy = %s, want %s; this test is not exercising the creative plan",
			tsk.Strategy, strategy.CreativeIterate)
	}
	if got := verdictOutcome(t, store, tsk.ID); got != "PASS" {
		t.Fatalf("approval was recorded as %s", got)
	}
	if tsk.Status != task.StatusCompleted {
		t.Fatalf("status = %s: %s", tsk.Status, tsk.Error)
	}
	if tsk.Repairs != 0 {
		t.Errorf("repairs = %d; approved work was sent round the loop anyway", tsk.Repairs)
	}
}

// A judgement with no verdict must complete rather than burn the repair
// budget, and must leave a trace saying nothing assessed it.
func TestUnjudgedCreativeWorkCompletesWithATrace(t *testing.T) {
	tsk, store := creativeRun(t, "Rendered it. Looks fine.")

	if tsk.Status != task.StatusCompleted {
		t.Fatalf("status = %s: %s", tsk.Status, tsk.Error)
	}
	if got := verdictOutcome(t, store, tsk.ID); got != "NEEDS_REVIEW" {
		t.Errorf("outcome = %s, want NEEDS_REVIEW; the run leaves no sign nothing judged it", got)
	}
}

// The verdict evaluator and the creative plan are two separate conditions on
// the same profile, and they have to agree. A live run found them disagreeing:
// a short creative request profiled as low complexity, ran direct with one
// implementer and no director at all, and still recorded "no VERDICT line;
// the result was not assessed against the brief" — a check reported as missed
// that was never part of the plan.
//
// This lives here because it is the only package that imports both sides.
func TestVerdictEvaluatorTracksTheCreativePlan(t *testing.T) {
	evals := evaluate.NewRegistry()
	if err := evals.RegisterDefaults(); err != nil {
		t.Fatal(err)
	}
	for _, complexity := range []task.Complexity{
		task.ComplexityLow, task.ComplexityMedium, task.ComplexityHigh,
	} {
		profile := task.Profile{
			Domain: task.DomainCreative, Complexity: complexity,
			Ambiguity: task.LevelLow, Risk: task.LevelLow, Verification: task.VerificationNone,
		}
		sel, err := (strategy.Selector{}).Select(strategy.Input{Profile: profile})
		if err != nil {
			t.Fatal(err)
		}
		judged := sel.Strategy == strategy.CreativeIterate

		var registered bool
		for _, e := range evals.ForTask(profile) {
			if e.Name() == "creative-verdict" {
				registered = true
			}
		}
		if registered != judged {
			t.Errorf("complexity %s: plan %s judges=%v but the verdict evaluator registered=%v",
				complexity, sel.Strategy, judged, registered)
		}
	}
}
