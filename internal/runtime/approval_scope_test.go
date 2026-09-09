package runtime

import (
	"context"
	"testing"

	"omniharness/internal/policy"
	"omniharness/internal/testutil"
	"omniharness/internal/tools"
)

// RunOptions.ApproveAll used to replace the process-wide approver and never put
// it back:
//
//	if opts.ApproveAll {
//	    r.Policy.SetApprover(alwaysGrant)
//	}
//
// One run therefore changed the safety posture of every later run in the same
// process. That is invisible on the CLI, where the process ends with the task —
// but `omniharness serve` is long-lived and takes concurrent requests, so a
// single POST /v1/tasks with {"approveAll":true} silently auto-approved
// everything the server did afterwards, including tasks that never asked for
// it.
func TestApproveAllDoesNotLeakIntoLaterRuns(t *testing.T) {
	dir := t.TempDir()
	fake := testutil.NewFakeOmniRoute(t, testutil.FakeStep{Content: "done"})
	rt := testRuntime(t, fake, dir)

	// A deliberate, remembered decision: this approver refuses everything.
	denials := 0
	rt.SetApprover(policy.ApproverFunc(func(context.Context, policy.Request, string) (bool, error) {
		denials++
		return false, nil
	}))

	ss, err := rt.NewSession(dir, "scope")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := rt.RunTask(context.Background(), ss.ID, "Say hello.", RunOptions{ApproveAll: true}); err != nil {
		t.Fatalf("RunTask: %v", err)
	}

	// After that run, an action the operator's policy says to ask about must
	// still be refused by the approver they installed.
	decision, err := rt.Policy.EvaluateAndExecute(context.Background(), policy.Request{
		Tool: "git", Risk: tools.RiskHigh, Input: map[string]any{"args": []any{"push"}},
	})
	if err != nil {
		t.Fatalf("EvaluateAndExecute: %v", err)
	}
	if decision == policy.Allow {
		t.Fatal("a high-risk action was allowed after an approve-all run; ApproveAll leaked out of its task")
	}
	if denials == 0 {
		t.Error("the installed approver was never consulted; it had been replaced")
	}
}

// The other half: approve-all must still work for the run that asked for it.
func TestApproveAllStillAppliesWithinItsOwnRun(t *testing.T) {
	dir := t.TempDir()
	fake := testutil.NewFakeOmniRoute(t, testutil.FakeStep{Content: "done"})
	rt := testRuntime(t, fake, dir)
	rt.SetApprover(policy.ApproverFunc(func(context.Context, policy.Request, string) (bool, error) {
		return false, nil
	}))

	ctx := policy.WithAutoApprove(context.Background())
	decision, err := rt.Policy.EvaluateAndExecute(ctx, policy.Request{
		Tool: "git", Risk: tools.RiskHigh, Input: map[string]any{"args": []any{"push"}},
	})
	if err != nil {
		t.Fatalf("EvaluateAndExecute: %v", err)
	}
	if decision != policy.Allow {
		t.Fatalf("decision = %v inside an approve-all run, want Allow", decision)
	}
}

// Auto-approval rides on the context, so it must not escape to a sibling.
func TestAutoApproveDoesNotEscapeItsContext(t *testing.T) {
	if policy.AutoApproved(context.Background()) {
		t.Error("a plain context reports auto-approval")
	}
	ctx := policy.WithAutoApprove(context.Background())
	if !policy.AutoApproved(ctx) {
		t.Error("a marked context does not report auto-approval")
	}
	if policy.AutoApproved(context.TODO()) {
		t.Error("auto-approval leaked to an unrelated context")
	}
}
