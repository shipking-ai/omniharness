package instructions

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestReadsAgentsFile(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "AGENTS.md", "# Build\n\nRun `make test` before finishing.\n")

	doc := Read(dir)
	if doc == nil {
		t.Fatal("AGENTS.md was not read")
	}
	if doc.Name != "AGENTS.md" {
		t.Fatalf("name = %q", doc.Name)
	}
	if !strings.Contains(doc.Content, "make test") {
		t.Fatalf("content = %q", doc.Content)
	}
	// The document goes in whole. Splitting a Markdown file into one-line
	// notes strips the headings, fences and lists it uses to be readable.
	lines := doc.Lines()
	if len(lines) != 1 {
		t.Fatalf("expected one labelled entry, got %d: %q", len(lines), lines)
	}
	if !strings.HasPrefix(lines[0], "From AGENTS.md in this repository:") {
		t.Fatalf("the entry must name its source so the model can weigh it: %q", lines[0])
	}
	if !strings.Contains(lines[0], "# Build") {
		t.Fatal("structure was stripped out of the document")
	}
}

// A repository carrying several of these is mirroring one source. Reading all
// of them puts the same guidance in the prompt twice and pays for it twice.
func TestCanonicalFileWinsWhenSeveralExist(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "AGENTS.md", "canonical guidance")
	write(t, dir, "CLAUDE.md", "mirrored guidance")
	write(t, dir, "GEMINI.md", "also mirrored")

	doc := Read(dir)
	if doc == nil || doc.Name != "AGENTS.md" {
		t.Fatalf("AGENTS.md must win, got %+v", doc)
	}
	if strings.Contains(doc.Content, "mirrored") {
		t.Fatalf("only one file should be read: %q", doc.Content)
	}
}

func TestFallsBackWhenCanonicalIsAbsent(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "CLAUDE.md", "fallback guidance")
	doc := Read(dir)
	if doc == nil || doc.Name != "CLAUDE.md" {
		t.Fatalf("expected CLAUDE.md fallback, got %+v", doc)
	}
}

// A placeholder file is not guidance, and stopping at it would hide a real one.
func TestEmptyFileIsSkippedRatherThanHonoured(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "AGENTS.md", "   \n\n\t\n")
	write(t, dir, "CLAUDE.md", "real guidance")

	doc := Read(dir)
	if doc == nil || doc.Name != "CLAUDE.md" {
		t.Fatalf("an empty AGENTS.md should not shadow a real CLAUDE.md, got %+v", doc)
	}
}

// Most repositories have no instruction file. That is the normal case, not an
// error, and it must never be a reason to fail a task.
func TestNoFileAndNoWorkspaceResolveToNothing(t *testing.T) {
	if doc := Read(t.TempDir()); doc != nil {
		t.Fatalf("expected nil for a workspace with no instruction file, got %+v", doc)
	}
	if doc := Read(""); doc != nil {
		t.Fatalf("expected nil for an empty workspace path, got %+v", doc)
	}
	if doc := Read(filepath.Join(t.TempDir(), "does-not-exist")); doc != nil {
		t.Fatalf("expected nil for a missing directory, got %+v", doc)
	}
	// And a nil Doc renders to nothing rather than panicking at the call site.
	var nilDoc *Doc
	if got := nilDoc.Lines(); got != nil {
		t.Fatalf("nil doc should render to nothing, got %q", got)
	}
}

// An over-long file must cost only its own tail. Left unbounded it would be
// trimmed by the composer's whole-prompt budget instead, pushing out the task
// profile and acceptance criteria to make room for itself.
func TestOverlongFileIsBoundedAndSaysSo(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "AGENTS.md", "head marker\n"+strings.Repeat("filler line\n", 4000)+"tail marker")

	doc := Read(dir)
	if doc == nil {
		t.Fatal("nil")
	}
	if !doc.Truncated {
		t.Fatal("a file past MaxBytes must be reported as truncated")
	}
	if len(doc.Content) > MaxBytes+128 {
		t.Fatalf("content is %d bytes, cap is %d", len(doc.Content), MaxBytes)
	}
	if !strings.HasPrefix(doc.Content, "head marker") {
		t.Fatal("the start of the file is the part worth keeping")
	}
	if strings.Contains(doc.Content, "tail marker") {
		t.Fatal("content past the cap should not be present")
	}
	if !strings.Contains(doc.Content, "truncated") {
		t.Fatal("a silently shortened instruction file is worse than a visibly shortened one")
	}
}
