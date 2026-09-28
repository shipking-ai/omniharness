package evaluate

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"omniharness/internal/task"
)

// With the shell off, the only evaluators that may still execute anything are
// the ones that compile or analyse without running workspace code. This is an
// allowlist on purpose: an evaluator added later that runs a test binary or a
// project script fails here until someone decides whether it executes code
// the model can write.
func TestShellOffLeavesOnlyEvaluatorsThatRunNoWorkspaceCode(t *testing.T) {
	r := NewRegistry()
	if err := r.RegisterDefaults(); err != nil {
		t.Fatal(err)
	}
	if r.AllowWorkspaceCode {
		t.Fatal("a new registry must fail closed")
	}
	var live, skipped []string
	for _, e := range r.ForTask(task.Profile{Domain: task.DomainSoftware, ModifiesFiles: true}) {
		if _, ok := e.(shellOff); ok {
			skipped = append(skipped, e.Name())
			continue
		}
		live = append(live, e.Name())
	}
	sort.Strings(live)
	if got, want := strings.Join(live, ","), "go-build,go-vet"; got != want {
		t.Fatalf("evaluators still running with the shell off = %s, want %s", got, want)
	}
	// The skipped checks keep their names, so the record says which ones did
	// not run rather than the list quietly getting shorter.
	sort.Strings(skipped)
	want := "cargo-build,cargo-test,diff-check,go-test,npm-build,npm-lint,npm-test,pytest"
	if got := strings.Join(skipped, ","); got != want {
		t.Fatalf("skipped = %s, want %s", got, want)
	}
	for _, e := range r.ForTask(task.Profile{Domain: task.DomainSoftware, ModifiesFiles: true}) {
		if _, ok := e.(shellOff); !ok {
			continue
		}
		outcome, detail, err := e.Evaluate(context.Background(), Request{})
		if err != nil || outcome != NeedsReview {
			// A skipped check reported as Pass would claim it had been made.
			t.Fatalf("%s: %s %q %v, want NEEDS_REVIEW", e.Name(), outcome, detail, err)
		}
	}
}

// git reads commands from the repository's own config: core.fsmonitor runs on
// a plain `git status`. write_file can write .git/config, so the diff check
// was a way to run a command of the model's choosing with the shell off.
func TestShellOffDiffCheckDoesNotRunRepositoryConfiguredCommands(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	dir := t.TempDir()
	for _, args := range [][]string{
		{"init", "-q"},
		{"-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"},
	} {
		if out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	cfg, err := os.OpenFile(filepath.Join(dir, ".git", "config"), os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := cfg.WriteString("[core]\n\tfsmonitor = \"touch MODEL_RAN_THIS; false\"\n"); err != nil {
		t.Fatal(err)
	}
	cfg.Close()
	marker := filepath.Join(dir, "MODEL_RAN_THIS")

	run := func(allow bool) {
		r := NewRegistry()
		if err := r.RegisterDefaults(); err != nil {
			t.Fatal(err)
		}
		r.AllowWorkspaceCode = allow
		for _, e := range r.ForTask(task.Profile{Domain: task.DomainSoftware, ModifiesFiles: true}) {
			if e.Name() == "diff-check" {
				_, _, _ = e.Evaluate(context.Background(), Request{CWD: dir})
				return
			}
		}
		t.Fatal("diff-check was not selected")
	}

	run(false)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("shell off, yet git ran the command planted in .git/config")
	}
	// And the plant is real: with the shell allowed the same check fires it.
	// Without this half, a git that ignored fsmonitor would pass the test.
	run(true)
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("the planted fsmonitor never ran even with the shell allowed; this test proves nothing on this git")
	}
}
