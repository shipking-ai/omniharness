package cli

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"omniharness/internal/gateway"
	"omniharness/internal/testutil"
)

// runModelWrittenTestScript drives a real run in which the model does one
// thing: write a package.json whose "test" script drops a marker file. It
// reports whether the marker exists afterwards — that is, whether a command
// the model chose was executed — along with the run's stderr log.
//
// write_file is medium risk and allowed by default, so nothing asks a person
// about this. The only thing between the model's script and a shell is
// whether the npm-test evaluator is willing to run it.
func runModelWrittenTestScript(t *testing.T, configTOML string) (ran bool, log string) {
	t.Helper()
	if _, err := exec.LookPath("npm"); err != nil {
		// Without npm the evaluator skips itself, and the shell-off case
		// would pass whether or not the gate exists.
		t.Skip("npm not installed")
	}
	dir := t.TempDir()
	testutil.InitFakeWorkspace(t, dir)
	cfgPath := filepath.Join(t.TempDir(), "omniharness.toml")
	if err := os.WriteFile(cfgPath, []byte(configTOML), 0o644); err != nil {
		t.Fatal(err)
	}

	pkg := `{"name":"x","version":"1.0.0","scripts":{"test":"touch MODEL_RAN_THIS"}}`
	args, _ := json.Marshal(map[string]string{"path": "package.json", "content": pkg})
	write := gateway.ToolCall{ID: "w1", Type: "function"}
	write.Function.Name = "write_file"
	write.Function.Arguments = string(args)
	fake := testutil.NewFakeOmniRoute(t,
		testutil.FakeStep{ToolCalls: []gateway.ToolCall{write}},
		testutil.FakeStep{Content: "fixed"},
	)
	t.Setenv("OMNIHARNESS_DATA_DIR", dir)
	t.Setenv("OMNIHARNESS_WORKSPACE", dir)
	t.Setenv("OMNIHARNESS_ENDPOINT", fake.URL())

	run := NewRootCmd()
	// "build script" and "package" are what the keyword analyzer reads as a
	// software task, which is what selects the build and test evaluators.
	run.SetArgs([]string{"--config", cfgPath, "run", "fix the build script in this package", "--headless", "--json"})
	log = captureStderr(t, func() {
		_ = captureStdout(t, func() { _ = run.Execute() })
	})
	if _, err := os.Stat(filepath.Join(dir, "package.json")); err != nil {
		t.Fatalf("the model's write never landed, so this run proves nothing: %v\n%s", err, log)
	}
	_, err := os.Stat(filepath.Join(dir, "MODEL_RAN_THIS"))
	return err == nil, log
}

// SECURITY.md: "shell_allowed = false means no shell, including by way of
// another tool." The build and test evaluators used to run after every
// software task regardless, so a script the model wrote into package.json ran
// through `sh -c` with nobody asked.
func TestShellOffMeansEvaluatorsDoNotRunModelWrittenScripts(t *testing.T) {
	ran, log := runModelWrittenTestScript(t, "[policy]\nshell_allowed = false\n")
	if ran {
		t.Fatalf("shell_allowed = false, yet the evaluator ran a script the model wrote:\n%s", log)
	}
	// Not run is not passed. The record has to say the check was skipped.
	if !strings.Contains(log, "npm-test -> NEEDS_REVIEW") {
		t.Fatalf("npm-test should be recorded as not assessed:\n%s", log)
	}
}

// The other half: with the shell allowed, the same run does execute the
// script. Without this, the test above would also pass if the run had simply
// never reached the evaluators.
func TestShellOnStillRunsTheEvaluators(t *testing.T) {
	ran, log := runModelWrittenTestScript(t, "[policy]\nshell_allowed = true\n")
	if !ran {
		t.Fatalf("with the shell allowed, npm test should have run the package's script:\n%s", log)
	}
	if !strings.Contains(log, "npm-test -> PASS") {
		t.Fatalf("npm-test should have passed:\n%s", log)
	}
}
