package evaluate

import (
	"context"
	"strings"
	"testing"

	"omniharness/internal/task"
)

func judged(text string) Request {
	return Request{Result: task.Result{Summary: text, Output: text}}
}

// The failure this evaluator exists to stop: a director that looked at the
// render, said it was wrong, and had the task recorded as a success.
func TestRejectedWorkFails(t *testing.T) {
	e := &CreativeVerdictEvaluator{}
	out, detail, err := e.Evaluate(context.Background(), judged(
		"The title strip never appears and the key light is far too warm.\nVERDICT: revise - add the title from frame 12 and cool the key light"))
	if err != nil {
		t.Fatal(err)
	}
	if out != Fail {
		t.Fatalf("outcome = %s, want FAIL", out)
	}
	// The detail is what the repair cycle hands the next attempt, so the
	// director's actual instruction has to survive into it.
	if !strings.Contains(detail, "cool the key light") {
		t.Errorf("detail %q drops the reason the director gave", detail)
	}
}

func TestApprovedWorkPasses(t *testing.T) {
	e := &CreativeVerdictEvaluator{}
	out, _, err := e.Evaluate(context.Background(), judged(
		"Framing matches the brief and the motion reads clearly.\nVERDICT: approved"))
	if err != nil {
		t.Fatal(err)
	}
	if out != Pass {
		t.Fatalf("outcome = %s, want PASS", out)
	}
}

// Models decorate final lines. Refusing a decorated verdict would report "not
// assessed" for a judgement that plainly gave one.
func TestDecoratedAndCasedVerdictsAreRead(t *testing.T) {
	for _, line := range []string{
		"**VERDICT: revise — the sky is blown out**",
		"## Verdict: Revise, the sky is blown out",
		"- verdict: revise: the sky is blown out",
	} {
		out, detail, _ := (&CreativeVerdictEvaluator{}).Evaluate(context.Background(), judged("looks off\n"+line))
		if out != Fail {
			t.Errorf("%q gave %s, want FAIL", line, out)
		}
		if !strings.Contains(detail, "sky is blown out") {
			t.Errorf("%q lost its reason: %q", line, detail)
		}
	}
}

// A judgement that reconsiders partway has to be read by its conclusion, not
// by the first verdict it happened to write down.
func TestLastVerdictWins(t *testing.T) {
	out, detail, _ := (&CreativeVerdictEvaluator{}).Evaluate(context.Background(), judged(
		"VERDICT: approved\n"+
			"On a second look at frame 24, the title strip never appears.\n"+
			"VERDICT: revise - restore the title strip"))
	if out != Fail {
		t.Fatalf("outcome = %s, want FAIL; the director's first verdict was read instead of its conclusion", out)
	}
	if !strings.Contains(detail, "restore the title strip") {
		t.Errorf("detail %q is not from the final verdict", detail)
	}
}

// The instruction the director is given contains both verdict words, so a
// reply that quotes it must not be mistaken for giving one.
func TestQuotedInstructionIsNotAVerdict(t *testing.T) {
	out, _, _ := (&CreativeVerdictEvaluator{}).Evaluate(context.Background(), judged(
		"You asked me to end with `VERDICT: approved` or `VERDICT: revise - reason`, "+
			"but I could not open the render, so I have nothing to judge."))
	if out != NeedsReview {
		t.Fatalf("outcome = %s, want NEEDS_REVIEW; a quoted instruction was read as a verdict", out)
	}
}

// A missing verdict must not fail the task. Sending good work around the
// repair loop three times because a model omitted a line is worse than
// completing it with a recorded note that nothing assessed it.
func TestMissingVerdictIsReviewedNotFailed(t *testing.T) {
	out, detail, _ := (&CreativeVerdictEvaluator{}).Evaluate(context.Background(),
		judged("Rendered both frames and they look fine to me."))
	if out != NeedsReview {
		t.Fatalf("outcome = %s, want NEEDS_REVIEW", out)
	}
	if detail == "" {
		t.Error("no detail recorded, so the run leaves no trace that nothing judged it")
	}
}

// An unrecognised word is the one case where guessing is dangerous: reading
// it as approval ships work nobody accepted.
func TestUnrecognisedVerdictIsNotApproval(t *testing.T) {
	out, _, _ := (&CreativeVerdictEvaluator{}).Evaluate(context.Background(), judged("VERDICT: maybe"))
	if out == Pass {
		t.Fatal("an unrecognised verdict was treated as approval")
	}
}

// Registration: the evaluator only matters if the domain actually gets it.
func TestCreativeTasksGetTheVerdictEvaluator(t *testing.T) {
	r := NewRegistry()
	if err := r.RegisterDefaults(); err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, e := range r.ForTask(task.Profile{Domain: task.DomainCreative}) {
		if e.Name() == "creative-verdict" {
			found = true
		}
	}
	if !found {
		t.Fatal("a creative task matches no verdict evaluator, so its judgement is discarded")
	}
	// And it must not start judging software runs, which have no director.
	for _, e := range r.ForTask(task.Profile{Domain: task.DomainSoftware}) {
		if e.Name() == "creative-verdict" {
			t.Error("a software task was given the creative verdict evaluator")
		}
	}
}
