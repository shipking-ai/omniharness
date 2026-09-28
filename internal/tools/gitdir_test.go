package tools

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// git runs commands named in the repository's own config. If write_file can
// reach .git/config, an approved `git status` runs whatever the model put in
// core.fsmonitor. This is the end-to-end shape: plant through the tool, then
// run the git tool the way an approver would see it.
func TestWriteFileCannotPlantACommandForGit(t *testing.T) {
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
	orig, err := os.ReadFile(filepath.Join(dir, ".git", "config"))
	if err != nil {
		t.Fatal(err)
	}
	r := newTestRegistry(t, dir)
	planted := string(orig) + "[core]\n\tfsmonitor = \"touch MODEL_RAN_THIS; false\"\n"

	_, err = mustTool(t, r, "write_file").Run(context.Background(), map[string]any{
		"path": ".git/config", "content": planted,
	})
	if err == nil || !strings.Contains(err.Error(), ".git") {
		t.Errorf("write_file into .git/config should be refused, got %v", err)
	}
	_, err = mustTool(t, r, "edit_file").Run(context.Background(), map[string]any{
		"path": ".git/config", "old_text": string(orig), "new_text": planted,
	})
	if err == nil {
		t.Error("edit_file into .git/config should be refused")
	}
	// What an approved call does next. If either write had landed, this runs
	// the planted command.
	_, _ = mustTool(t, r, "git").Run(context.Background(), map[string]any{"args": []any{"status"}})
	if _, err := os.Stat(filepath.Join(dir, "MODEL_RAN_THIS")); err == nil {
		t.Fatal("git ran a command the model wrote into .git/config")
	}
	if got, _ := os.ReadFile(filepath.Join(dir, ".git", "config")); string(got) != string(orig) {
		t.Fatalf(".git/config changed:\n%s", got)
	}
}

// Every spelling a filesystem git runs on treats as .git, and a symlink into
// it. Each is refused; ordinary files that merely look similar are not.
func TestWriteFileRefusesEverySpellingOfGitDir(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	r := newTestRegistry(t, dir)
	write := func(p string) error {
		_, err := mustTool(t, r, "write_file").Run(context.Background(), map[string]any{"path": p, "content": "x"})
		return err
	}
	refused := []string{
		".git/config",
		".git/hooks/pre-commit",
		"sub/.git/config",                // a nested repository
		".GIT/config",                    // case-folding filesystems
		".git./config",                   // Windows drops trailing dots
		".git /config",                   // and trailing spaces
		".git::$INDEX_ALLOCATION/config", // an NTFS stream name for the directory
		"GIT~1/config",                   // its 8.3 short name
		".g‌it/config",                   // HFS+ ignores zero-width characters
		"a/../.git/config",
	}
	for _, p := range refused {
		if err := write(p); err == nil {
			t.Errorf("%q: write was allowed", p)
		}
	}
	// A .git file points git at any directory ("gitdir: ..."), so creating
	// one is as good as writing a config. Judged in a workspace without one,
	// where the write would otherwise succeed.
	bare := newTestRegistry(t, t.TempDir())
	if _, err := mustTool(t, bare, "write_file").Run(context.Background(), map[string]any{
		"path": ".git", "content": "gitdir: elsewhere\n",
	}); err == nil {
		t.Error("creating a .git file was allowed")
	}
	if runtime.GOOS != "windows" {
		if err := os.Symlink(filepath.Join(dir, ".git"), filepath.Join(dir, "innocent")); err != nil {
			t.Fatal(err)
		}
		if err := write("innocent/config"); err == nil {
			t.Error("a symlink into .git let the write through")
		}
	}
	for _, p := range []string{".gitignore", ".github/workflows/ci.yml", "git/config", "docs/.gitkeep", "x.git"} {
		if err := write(p); err != nil {
			t.Errorf("%q should be writable: %v", p, err)
		}
	}
	// Reading .git stays allowed; only writing is the problem.
	if err := os.WriteFile(filepath.Join(dir, ".git", "HEAD"), []byte("ref: refs/heads/main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := mustTool(t, r, "read_file").Run(context.Background(), map[string]any{"path": ".git/HEAD"}); err != nil {
		t.Fatalf("reading .git/HEAD should still work: %v", err)
	}
}

// A workspace that itself sits under a directory named .git must still be
// usable: only components inside the workspace are judged.
func TestWriteFileJudgesOnlyPathsInsideTheWorkspace(t *testing.T) {
	dir := filepath.Join(t.TempDir(), ".git", "work")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	r := newTestRegistry(t, dir)
	if _, err := mustTool(t, r, "write_file").Run(context.Background(), map[string]any{
		"path": "main.go", "content": "package main",
	}); err != nil {
		t.Fatalf("a workspace under .git refused an ordinary write: %v", err)
	}
}
