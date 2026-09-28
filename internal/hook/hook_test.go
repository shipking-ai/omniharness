package hook

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func deny(name, reason string, at ...Point) Hook {
	return Func{HookName: name, At: at, Fn: func(context.Context, Call) error { return errors.New(reason) }}
}

func allow(name string, at ...Point) Hook {
	return Func{HookName: name, At: at, Fn: func(context.Context, Call) error { return nil }}
}

// --- what a hook is for -------------------------------------------------------

func TestDenialStopsTheCallAndSaysWhichRule(t *testing.T) {
	r := NewRegistry()
	if err := r.Add(deny("workspace-confinement", "path is outside the workspace", BeforeTool)); err != nil {
		t.Fatal(err)
	}
	err := r.Run(context.Background(), Call{Point: BeforeTool, Tool: "write_file"})
	if err == nil {
		t.Fatal("the hook denied and the call was allowed")
	}
	// The reason reaches the model, so it has to name the rule and say what
	// was refused — "denied" alone tells it nothing it can act on.
	if !strings.Contains(err.Error(), "workspace-confinement") || !strings.Contains(err.Error(), "outside the workspace") {
		t.Fatalf("denial should name the rule and the reason, got %q", err)
	}
	var d *Denial
	if !errors.As(err, &d) {
		t.Fatal("a denial should be matchable by type, not by message text")
	}
}

func TestSilenceIsNotDenial(t *testing.T) {
	r := NewRegistry()
	_ = r.Add(allow("counter", BeforeTool))
	_ = r.Add(allow("other", BeforeTool))
	if err := r.Run(context.Background(), Call{Point: BeforeTool, Tool: "read_file"}); err != nil {
		t.Fatalf("no hook objected, so the call should proceed: %v", err)
	}
}

// A registry with nothing in it, and a nil registry, both stand aside — so a
// runtime with no hooks configured pays for none of this.
func TestEmptyAndNilRegistriesAllowEverything(t *testing.T) {
	if err := NewRegistry().Run(context.Background(), Call{Point: BeforeTool}); err != nil {
		t.Fatal(err)
	}
	var nilReg *Registry
	if err := nilReg.Run(context.Background(), Call{Point: BeforeTool}); err != nil {
		t.Fatal(err)
	}
	if got := nilReg.Names(BeforeTool); got != nil {
		t.Fatalf("nil registry should list nothing, got %v", got)
	}
}

// --- the property the whole design rests on ----------------------------------

// A hook can refuse and nothing else. If one could sanction an action it would
// be a way around policy and the approval gate, and the first thing anyone
// would write is the hook that approves everything. The Hook interface has no
// way to express approval — this test exists so that stays true.
func TestHooksCannotApproveOnlyRefuse(t *testing.T) {
	// A hook that tries as hard as the interface permits to say "yes".
	permissive := Func{
		HookName: "approve-everything",
		At:       []Point{BeforeTool},
		Fn:       func(context.Context, Call) error { return nil },
	}
	r := NewRegistry()
	_ = r.Add(permissive)
	_ = r.Add(deny("no-shell", "shell is disabled in this workspace", BeforeTool))

	err := r.Run(context.Background(), Call{Point: BeforeTool, Tool: "run_command"})
	if err == nil {
		t.Fatal("a permissive hook overrode a denial — hooks must not be able to grant")
	}
	if !strings.Contains(err.Error(), "no-shell") {
		t.Fatalf("the denial should survive, got %q", err)
	}
}

// Every hook runs even after one denies, so behaviour does not depend on the
// order rules happen to be registered in; the denial reported is the first in
// registration order so the answer is stable between runs.
func TestAllHooksRunAndTheFirstDenialIsReported(t *testing.T) {
	var ran int32
	count := Func{HookName: "counter", At: []Point{BeforeTool}, Fn: func(context.Context, Call) error {
		atomic.AddInt32(&ran, 1)
		return nil
	}}
	r := NewRegistry()
	_ = r.Add(deny("first-rule", "first reason", BeforeTool))
	_ = r.Add(deny("second-rule", "second reason", BeforeTool))
	_ = r.Add(count)

	for i := 0; i < 5; i++ {
		err := r.Run(context.Background(), Call{Point: BeforeTool})
		if err == nil || !strings.Contains(err.Error(), "first-rule") {
			t.Fatalf("run %d reported %v, want the first registered denial", i, err)
		}
	}
	if got := atomic.LoadInt32(&ran); got != 5 {
		t.Fatalf("the later hook ran %d times in 5 runs — a denial should not skip the rest", got)
	}
}

// --- a guard that fails is not a guard ---------------------------------------

func TestPanickingGuardDenies(t *testing.T) {
	r := NewRegistry()
	_ = r.Add(Func{HookName: "broken", At: []Point{BeforeTool}, Fn: func(context.Context, Call) error {
		panic("nil map or something")
	}})
	err := r.Run(context.Background(), Call{Point: BeforeTool, Tool: "write_file"})
	if err == nil {
		t.Fatal("a crashed guard let the call through — the rule would be unenforced while still claimed")
	}
	if !strings.Contains(err.Error(), "panicked") {
		t.Fatalf("the denial should say the hook broke, got %q", err)
	}
}

func TestHangingGuardDeniesRatherThanStallingTheRun(t *testing.T) {
	r := NewRegistry()
	r.Timeout = 50 * time.Millisecond
	_ = r.Add(Func{HookName: "slow", At: []Point{BeforeTool}, Fn: func(ctx context.Context, _ Call) error {
		<-time.After(10 * time.Second)
		return nil
	}})

	start := time.Now()
	err := r.Run(context.Background(), Call{Point: BeforeTool})
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("a hook that never answered should deny, not allow")
	}
	if elapsed > 2*time.Second {
		t.Fatalf("the run was held for %s by one hook", elapsed)
	}
	if !strings.Contains(err.Error(), "did not answer") {
		t.Fatalf("got %q", err)
	}
}

// At an observation point the work has already happened, so there is nothing
// left to refuse and a broken hook must not turn a finished call into a
// failure.
func TestFailingObserverDoesNotDenyCompletedWork(t *testing.T) {
	r := NewRegistry()
	_ = r.Add(deny("noisy-observer", "I object", AfterTool))
	_ = r.Add(Func{HookName: "crasher", At: []Point{AfterTool}, Fn: func(context.Context, Call) error {
		panic("boom")
	}})

	if err := r.Run(context.Background(), Call{Point: AfterTool, Tool: "write_file", Status: "completed"}); err != nil {
		t.Fatalf("an observer cannot refuse work that already happened: %v", err)
	}
}

// --- registration ------------------------------------------------------------

func TestRegistrationRejectsHooksThatCannotBeUsed(t *testing.T) {
	r := NewRegistry()
	if err := r.Add(nil); err == nil {
		t.Error("a nil hook should be rejected")
	}
	if err := r.Add(Func{At: []Point{BeforeTool}}); err == nil {
		t.Error("an unnamed hook should be rejected — the name is what a denial cites")
	}
	if err := r.Add(Func{HookName: "nowhere"}); err == nil {
		t.Error("a hook registered at no point would never run and is a configuration mistake")
	}
}

func TestHooksOnlyRunAtTheirOwnPoints(t *testing.T) {
	r := NewRegistry()
	_ = r.Add(deny("tool-only", "no", BeforeTool))
	if err := r.Run(context.Background(), Call{Point: BeforeModel}); err != nil {
		t.Fatalf("a before_tool hook fired at before_model: %v", err)
	}
	if err := r.Run(context.Background(), Call{Point: BeforeTool}); err == nil {
		t.Fatal("and it should still fire at its own point")
	}
	if got := fmt.Sprint(r.Names(BeforeTool)); got != "[tool-only]" {
		t.Fatalf("Names = %s", got)
	}
}

// A guard sees real arguments, not the clipped copy that goes to the event
// log: a rule about paths cannot tell one inside the workspace from one
// outside it if the value was truncated on the way.
func TestGuardSeesRealArguments(t *testing.T) {
	long := "/etc/" + strings.Repeat("a", 500) + "/passwd"
	var seen string
	r := NewRegistry()
	_ = r.Add(Func{HookName: "path-check", At: []Point{BeforeTool}, Fn: func(_ context.Context, c Call) error {
		seen, _ = c.Args["path"].(string)
		return nil
	}})
	_ = r.Run(context.Background(), Call{Point: BeforeTool, Tool: "read_file", Args: map[string]any{"path": long}})
	if seen != long {
		t.Fatalf("the hook saw %d bytes of a %d byte path", len(seen), len(long))
	}
}
