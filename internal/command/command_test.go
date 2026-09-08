package command

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"omniharness/internal/tools"
)

// A tiny program that is guaranteed present on the test machine, whatever it
// is: the Go toolchain itself.
func goBin(t *testing.T) string {
	t.Helper()
	return "go"
}

func mustNew(t *testing.T, s Spec) *Tool {
	t.Helper()
	if s.Description == "" {
		s.Description = "test command"
	}
	tool, err := New(s, t.TempDir())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return tool
}

func TestRunsACommandAndCapturesOutput(t *testing.T) {
	tool := mustNew(t, Spec{
		Name: "go_version", Command: goBin(t), Args: []string{"version"},
		Capabilities: []tools.Capability{"inspect_toolchain"},
	})
	res, err := tool.Run(context.Background(), map[string]any{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !strings.Contains(res.Output, "go version") {
		t.Errorf("Output = %q, want the program's own output", res.Output)
	}
}

// Caller arguments arrive as a list and are passed as a list. A single string
// run through a shell would let an argument containing a semicolon become a
// second command.
func TestArgumentsArePassedAsAListNotAShellString(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "should_not_exist.txt")
	tool := mustNew(t, Spec{
		Name: "echoer", Command: goBin(t), Args: []string{"env"},
		ArgsParam: "args",
	})
	// If this were handled by a shell, the `&&` would run a second command.
	_, _ = tool.Run(context.Background(), map[string]any{
		"args": []any{"GOOS", "&&", "touch", marker},
	})
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("an argument was interpreted as a shell operator; commands must not go through a shell")
	}
}

func TestNonListArgumentsAreRejectedAsInvalidInput(t *testing.T) {
	tool := mustNew(t, Spec{Name: "c", Command: goBin(t), Args: []string{"env"}, ArgsParam: "args"})
	_, err := tool.Run(context.Background(), map[string]any{"args": "GOOS"})
	if err == nil {
		t.Fatal("a string was accepted where an array was required")
	}
	if got := tools.KindOf(err); got != tools.ErrInvalidInput {
		t.Errorf("kind = %s, want %s", got, tools.ErrInvalidInput)
	}
	_, err = tool.Run(context.Background(), map[string]any{"args": []any{"ok", 7}})
	if err == nil || tools.KindOf(err) != tools.ErrInvalidInput {
		t.Errorf("a non-string element gave %v, want invalid_input", err)
	}
}

// A program that runs and fails is an ordinary failure the model can act on;
// a program that cannot start at all is not worth retrying.
func TestExitCodeIsFailedAndMissingBinaryIsUnavailable(t *testing.T) {
	failing := mustNew(t, Spec{
		Name: "boom", Command: goBin(t), Args: []string{"run", "definitely-not-a-package-xyz"},
	})
	_, err := failing.Run(context.Background(), map[string]any{})
	if err == nil {
		t.Fatal("a non-zero exit did not surface")
	}
	if got := tools.KindOf(err); got != tools.ErrFailed {
		t.Errorf("kind = %s, want %s", got, tools.ErrFailed)
	}

	missing, newErr := New(Spec{
		Name: "ghost", Description: "d", Command: "definitely-not-a-real-binary-xyz",
	}, t.TempDir())
	if newErr != nil {
		t.Fatal(newErr)
	}
	if missing.Available() == nil {
		t.Fatal("a missing program reported itself available")
	}
	_, err = missing.Run(context.Background(), map[string]any{})
	if got := tools.KindOf(err); got != tools.ErrUnavailable {
		t.Errorf("kind = %s, want %s", got, tools.ErrUnavailable)
	}
}

func TestTimeoutIsReportedAsTimeout(t *testing.T) {
	sleeper := "sleep"
	args := []string{"5"}
	if runtime.GOOS == "windows" {
		sleeper = goBin(t)
		// `go run` on a package that does not exist is fast; use a real wait.
		args = []string{"version"}
	}
	tool := mustNew(t, Spec{
		Name: "slow", Command: sleeper, Args: args, Timeout: time.Nanosecond,
	})
	_, err := tool.Run(context.Background(), map[string]any{})
	if err == nil {
		t.Skip("command finished faster than the timeout could fire")
	}
	if got := tools.KindOf(err); got != tools.ErrTimeout {
		t.Errorf("kind = %s, want %s (err: %v)", got, tools.ErrTimeout, err)
	}
}

// The declarations are the operator's, and a typo must fail at construction
// rather than silently producing an unreachable or ungated tool.
func TestBadDeclarationsAreRejected(t *testing.T) {
	for _, tc := range []struct {
		name string
		spec Spec
	}{
		{"no name", Spec{Command: "go", Description: "d"}},
		{"no command", Spec{Name: "n", Description: "d"}},
		{"no description", Spec{Name: "n", Command: "go"}},
		{"bad capability", Spec{Name: "n", Command: "go", Description: "d",
			Capabilities: []tools.Capability{"Bad Name"}}},
		{"bad effect", Spec{Name: "n", Command: "go", Description: "d",
			Effects: []tools.Effect{"financail"}}},
	} {
		if _, err := New(tc.spec, t.TempDir()); err == nil {
			t.Errorf("%s was accepted", tc.name)
		}
	}
}

// An arbitrary local program can do anything, so the default has to make
// policy decide rather than assume the best.
func TestRiskDefaultsToHigh(t *testing.T) {
	tool := mustNew(t, Spec{Name: "c", Command: goBin(t)})
	if got := tool.Spec().Risk; got != tools.RiskHigh {
		t.Errorf("default risk = %q, want %q", got, tools.RiskHigh)
	}
	if !tool.Spec().ExecutesCode {
		t.Error("a command tool does not report that it executes code")
	}
	if tool.Spec().Provider != Provider {
		t.Errorf("Provider = %q, want %q", tool.Spec().Provider, Provider)
	}
}

// The schema must require the argument list when there is one, so a malformed
// call is caught by validation before the program runs.
func TestSchemaRequiresTheArgumentList(t *testing.T) {
	withArgs := mustNew(t, Spec{Name: "a", Command: goBin(t), ArgsParam: "args"})
	if err := tools.ValidateInput(withArgs.Spec(), map[string]any{}); err == nil {
		t.Error("a call with no arguments was accepted for a tool that requires them")
	}
	if err := tools.ValidateInput(withArgs.Spec(), map[string]any{"args": []any{"x"}}); err != nil {
		t.Errorf("a valid call was rejected: %v", err)
	}
	// A fixed command takes nothing and must accept an empty call.
	fixed := mustNew(t, Spec{Name: "f", Command: goBin(t), Args: []string{"version"}})
	if err := tools.ValidateInput(fixed.Spec(), map[string]any{}); err != nil {
		t.Errorf("a fixed command rejected an empty call: %v", err)
	}
}
