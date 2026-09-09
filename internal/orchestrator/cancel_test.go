package orchestrator

import (
	"context"
	"sync"
	"testing"
	"time"

	"omniharness/internal/task"
	"omniharness/internal/testutil"
)

// Cancellation used to be a single cancel function on the orchestrator, which
// assumed one task at a time. `omniharness serve` accepts concurrent POSTs to
// /v1/tasks, so the second run overwrote the first run's handle: the only
// cancel in the process pointed at whichever task started last, and every
// earlier one was uncancellable.
//
// Two tasks run at once here. Cancelling the *first* must stop the first —
// under the old code the handle had already been replaced, so the call either
// stopped the wrong run or did nothing at all.
func TestCancelTaskStopsTheTaskItNames(t *testing.T) {
	dir := t.TempDir()
	// Long enough that both runs are still in flight when we cancel.
	fake := testutil.NewFakeOmniRoute(t, testutil.FakeStep{Content: "done", Delay: 3 * time.Second})
	o, _, _ := newOrchestrator(t, fake, dir)

	started := make(chan string, 2)
	o.deps.Bus.Subscribe(16)
	sub, unsub := o.deps.Bus.Subscribe(64)
	defer unsub()
	go func() {
		seen := map[string]bool{}
		for e := range sub {
			if e.Type == "task.started" && e.TaskID != "" && !seen[e.TaskID] {
				seen[e.TaskID] = true
				started <- e.TaskID
			}
		}
	}()

	var wg sync.WaitGroup
	results := make(chan *task.Task, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
			defer cancel()
			tsk, _ := o.Run(ctx, "s1", task.Spec{Prompt: "Fix the typo in README.md.", CWD: dir}, "")
			results <- tsk
		}()
	}

	var ids []string
	for len(ids) < 2 {
		select {
		case id := <-started:
			ids = append(ids, id)
		case <-time.After(20 * time.Second):
			t.Fatalf("only %d task(s) started; this test is not exercising concurrency", len(ids))
		}
	}

	// The invariant, and the whole point: while two tasks are running, both
	// are addressable. A single shared handle can only name one of them, so
	// one of these two calls comes back false — and which one depends on
	// registration order, not on anything the caller can see.
	//
	// Asserted on both rather than on "the first", because the task.started
	// events are published before the cancel handle is registered, so event
	// order is not registration order and picking one would pass or fail by
	// luck. It did: an earlier version of this test passed against the broken
	// code.
	// Polled, not sampled once: task.started is published before the handle is
	// registered, so both events can arrive before either registration lands.
	// A correct implementation reaches two handles almost immediately; one that
	// shares a single handle never does.
	live := 0
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); {
		o.cancelMu.Lock()
		live = len(o.cancels)
		o.cancelMu.Unlock()
		if live == 2 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if live != 2 {
		t.Fatalf("%d cancel handle(s) while 2 tasks are running; the handles overwrite each other", live)
	}
	for _, id := range ids {
		if !o.CancelTask(id) {
			t.Errorf("CancelTask(%s) reported the task was not running, while it was", id)
		}
	}

	wg.Wait()
	close(results)
	for tsk := range results {
		if tsk != nil && tsk.Status == task.StatusCompleted {
			t.Errorf("task %s completed despite being cancelled", tsk.ID)
		}
	}
}

// An id that is not running must say so, or a client cannot tell a successful
// cancel from a typo.
func TestCancelTaskReportsAnUnknownID(t *testing.T) {
	o, _, _ := newOrchestrator(t, testutil.NewFakeOmniRoute(t, testutil.FakeStep{Content: "x"}), t.TempDir())
	if o.CancelTask("never-existed") {
		t.Error("CancelTask reported success for an id that was never running")
	}
	if o.CancelTask("") {
		t.Error("CancelTask reported success for an empty id")
	}
}

// The map must not grow for the life of the process.
func TestCancelHandlesAreReleasedWhenATaskEnds(t *testing.T) {
	dir := t.TempDir()
	o, _, _ := newOrchestrator(t, testutil.NewFakeOmniRoute(t, testutil.FakeStep{Content: "done"}), dir)
	tsk, err := runTask(t, o, "s1", task.Spec{Prompt: "Fix the typo in README.md.", CWD: dir})
	if err != nil {
		t.Fatal(err)
	}
	o.cancelMu.Lock()
	n := len(o.cancels)
	o.cancelMu.Unlock()
	if n != 0 {
		t.Errorf("%d cancel handles left after the run finished", n)
	}
	if o.CancelTask(tsk.ID) {
		t.Error("a finished task still reports as cancellable")
	}
}
