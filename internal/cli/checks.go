package cli

import (
	"context"
	"net/http"
	"sync"
	"time"

	"omniharness/internal/evaluate"
	"omniharness/internal/event"
	"omniharness/internal/runtime"
	"omniharness/internal/task"
)

// checkRunTimeout bounds a whole on-demand check run.
//
// Generous, because `go test ./...` on a real repository is minutes, not
// seconds, and a check that gets killed halfway is worse than no check: it
// reports a failure the code did not cause.
const checkRunTimeout = 15 * time.Minute

// checksRunning stops two check runs overlapping.
//
// They shell out to the same build directory. Two `go build ./...` in one
// module fight over the build cache and produce failures that belong to the
// race rather than to the code — which is exactly the kind of false red that
// teaches people to ignore a checks panel.
var checksRunning sync.Mutex

// checksHandler runs the repository's own verification and publishes what it
// finds onto the event bus.
//
// This is the answer to the loudest complaint about coding agents: they report
// success without evidence. The harness has had evaluators for months — go
// build, go test, npm, cargo, pytest, diff-check — and they only ever ran as
// part of a task's own lifecycle, where nothing surfaced them. Asking for them
// directly means a person can say "prove it" about work the agent claims to
// have finished.
//
// Results are published rather than returned, so every attached surface fills
// in as they land instead of one caller holding a socket open for minutes. The
// response is an acknowledgement.
func checksHandler(rt *runtime.Runtime, cwd string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !checksRunning.TryLock() {
			writeJSON(w, http.StatusConflict, map[string]any{
				"error": "a check run is already in progress",
			})
			return
		}

		// The software profile is what selects the build and test evaluators.
		// Each one checks for its own project marker and skips when there is
		// none, so offering all of them to any workspace is correct rather
		// than lazy: a repository with both go.mod and package.json genuinely
		// wants both.
		evaluators := rt.Evaluators.ForTask(task.Profile{Domain: task.DomainSoftware})
		names := make([]string, 0, len(evaluators))
		for _, e := range evaluators {
			names = append(names, e.Name())
		}

		go func() {
			defer checksRunning.Unlock()
			ctx, cancel := context.WithTimeout(context.Background(), checkRunTimeout)
			defer cancel()
			runChecks(ctx, rt, cwd, evaluators)
		}()

		writeJSON(w, http.StatusAccepted, map[string]any{
			"running":    true,
			"evaluators": names,
		})
	}
}

// runChecksWithBus executes each evaluator in turn and publishes the outcome
// onto the given bus.
//
// In turn rather than in parallel: they run build systems, and two toolchains
// competing for the same cache is slower than doing it one at a time as well
// as being a source of failures that are not real.
//
// Split out from checksHandler so the error-handling contract — a tool that
// cannot run is NEEDS_REVIEW, not FAIL — can be asserted without standing up a
// full runtime.
func runChecksWithBus(ctx context.Context, bus *event.Bus, cwd string, evaluators []evaluate.Evaluator) {
	for _, e := range evaluators {
		if ctx.Err() != nil {
			return
		}
		bus.Publish(event.New(&event.EvaluationData{
			Evaluator: e.Name(), Outcome: "running",
		}))

		outcome, detail, err := e.Evaluate(ctx, evaluate.Request{CWD: cwd})
		if err != nil {
			// An evaluator that could not run is not a failing check. Saying
			// FAIL here would report the harness's own problem as the
			// repository's.
			outcome, detail = evaluate.NeedsReview, "the check could not run: "+err.Error()
		}
		bus.Publish(event.New(&event.EvaluationCompletedData{
			Evaluator: e.Name(),
			Outcome:   string(outcome),
			Detail:    detail,
		}))
	}
}

// runChecks runs the repository's checks through the runtime's event bus.
func runChecks(ctx context.Context, rt *runtime.Runtime, cwd string, evaluators []evaluate.Evaluator) {
	runChecksWithBus(ctx, rt.Bus, cwd, evaluators)
}
