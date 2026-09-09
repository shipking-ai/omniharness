package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// config/omniharness.example.toml — the file the docs tell people to copy —
// shipped `dir = "~/.omniharness"`, and nothing expanded it. On Windows no
// shell is involved, so the harness created a directory literally named "~"
// wherever it was started and put the session database inside. One of those
// turned up in this repository's own root.
func TestLoadExpandsATildePersistenceDir(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		t.Skip("no home directory on this machine")
	}
	path := filepath.Join(t.TempDir(), "omniharness.toml")
	if err := os.WriteFile(path, []byte(`
[omniroute]
endpoint = "http://127.0.0.1:20128"
timeout = "2m"

[persistence]
dir = "~/.omniharness"
`), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if strings.HasPrefix(cfg.Persistence.Dir, "~") {
		t.Fatalf("persistence.dir = %q; a literal ~ creates a directory named \"~\"", cfg.Persistence.Dir)
	}
	if want := filepath.Join(home, ".omniharness"); cfg.Persistence.Dir != want {
		t.Errorf("persistence.dir = %q, want %q", cfg.Persistence.Dir, want)
	}
}

// The example config is the thing that produced the bug, so it is worth
// asserting that whatever it ships actually resolves.
func TestExampleConfigPersistenceDirResolves(t *testing.T) {
	cfg, err := Load(filepath.Join("..", "..", "config", "omniharness.example.toml"))
	if err != nil {
		t.Fatalf("the shipped example config does not load: %v", err)
	}
	if strings.HasPrefix(cfg.Persistence.Dir, "~") {
		t.Errorf("the example config yields persistence.dir = %q, which creates a directory named \"~\"", cfg.Persistence.Dir)
	}
	if !filepath.IsAbs(cfg.Persistence.Dir) {
		t.Errorf("the example config yields a relative persistence.dir = %q, so the store follows the working directory", cfg.Persistence.Dir)
	}
}

func TestExpandHomeLeavesOtherPathsAlone(t *testing.T) {
	// A bare "~" is more likely a mistake than a request for home, and
	// "~user" is another account's home on Unix — neither is ours to rewrite.
	for _, p := range []string{"", "~", "~backup", "./relative", "/absolute", "C:\\Windows"} {
		if got := expandHome(p); got != p {
			t.Errorf("expandHome(%q) = %q, want it unchanged", p, got)
		}
	}
}

// Windows separators are the case that matters most here, since Windows is
// where no shell expands ~ for you.
func TestExpandHomeAcceptsBothSeparators(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		t.Skip("no home directory on this machine")
	}
	want := filepath.Join(home, "work")
	for _, p := range []string{"~/work", "~\\work"} {
		if got := expandHome(p); got != want {
			t.Errorf("expandHome(%q) = %q, want %q", p, got, want)
		}
	}
}
