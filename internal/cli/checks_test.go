package cli

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"omniharness/internal/evaluate"
	"omniharness/internal/event"
)

// fakeEvaluator stands in for a build system.
type fakeEvaluator struct {
	name    string
	outcome evaluate.Outcome
	detail  string
	err     error
	block   chan struct{}
}

func (f *fakeEvaluator) Name() string { return f.name }

func (f *fakeEvaluator) Evaluate(ctx context.Context, _ evaluate.Request) (evaluate.Outcome, string, error) {
	if f.block != nil {
		select {
		case <-f.block:
		case <-ctx.Done():
			return evaluate.NeedsReview, "cancelled", nil
		}
	}
	return f.outcome, f.detail, f.err
}

// collect subscribes and returns the evaluation.completed payloads seen.
func collect(t *testing.T, bus *event.Bus, want int) []event.EvaluationCompletedData {
	t.Helper()
	ch, cancel := bus.SubscribeTo(64, event.EvaluationComplete)
	t.Cleanup(cancel)
	done := make(chan []event.EvaluationCompletedData, 1)
	go func() {
		var got []event.EvaluationCompletedData
		for e := range ch {
			var d event.EvaluationCompletedData
			if err := json.Unmarshal(e.Data, &d); err == nil {
				got = append(got, d)
			}
			if len(got) >= want {
				break
			}
		}
		done <- got
	}()
	return waitFor(t, done)
}

func waitFor(t *testing.T, done chan []event.EvaluationCompletedData) []event.EvaluationCompletedData {
	t.Helper()
	select {
	case got := <-done:
		return got
	case <-time.After(5 * time.Second):
		t.Fatal("the check run published nothing within 5s")
		return nil
	}
}

// An evaluator that cannot run has not found a problem with the code. Calling
// that FAIL reports the harness's own trouble — a missing toolchain, a broken
// sandbox — as the repository's, which is exactly the false red that teaches
// people to stop reading a checks panel.
func TestAnEvaluatorThatCannotRunIsNotAFailingCheck(t *testing.T) {
	bus := event.NewBus()
	defer bus.Close()

	results := make(chan []event.EvaluationCompletedData, 1)
	go func() { results <- collect(t, bus, 2) }()
	time.Sleep(50 * time.Millisecond) // let the subscription attach

	runChecksWithBus(context.Background(), bus, t.TempDir(), []evaluate.Evaluator{
		&fakeEvaluator{name: "broken", err: errors.New("go: not found")},
		&fakeEvaluator{name: "real", outcome: evaluate.Fail, detail: "build failed"},
	})

	got := <-results
	if len(got) < 2 {
		t.Fatalf("published %d results, want 2", len(got))
	}
	byName := map[string]event.EvaluationCompletedData{}
	for _, d := range got {
		byName[d.Evaluator] = d
	}
	if o := byName["broken"].Outcome; o != string(evaluate.NeedsReview) {
		t.Errorf("an evaluator that errored reported %q, want %q — a tool that could not run is not a failing build",
			o, evaluate.NeedsReview)
	}
	if o := byName["real"].Outcome; o != string(evaluate.Fail) {
		t.Errorf("a genuinely failing check reported %q, want FAIL", o)
	}
}

// Two runs at once shell out to the same build directory. Two `go build ./...`
// in one module fight over the build cache and produce failures that belong to
// the race rather than to the code.
func TestASecondCheckRunIsRefusedWhileOneIsInFlight(t *testing.T) {
	if !checksRunning.TryLock() {
		t.Fatal("the check lock was already held at the start of the test")
	}
	if checksRunning.TryLock() {
		checksRunning.Unlock()
		checksRunning.Unlock()
		t.Fatal("the lock admitted a second holder; two check runs would race the build cache")
	}
	checksRunning.Unlock()
	if !checksRunning.TryLock() {
		t.Fatal("the lock was not released")
	}
	checksRunning.Unlock()
}
