package cli

import "testing"

// An MCP tool's description is its function's docstring: it routinely starts
// with a newline and runs to several paragraphs. Printed straight into a %s
// that made every tool from a real server look as though it had no
// description at all — the first line of output was blank and the rest wrapped
// below the next entry.
func TestOneLineFlattensDocstringDescriptions(t *testing.T) {
	docstring := "\n    Capture a screenshot of the current Blender 3D viewport.\n\n" +
		"    Parameters:\n    - max_size: Maximum size in pixels\n    "
	got := oneLine(docstring, 0)
	want := "Capture a screenshot of the current Blender 3D viewport. Parameters: - max_size: Maximum size in pixels"
	if got != want {
		t.Fatalf("oneLine = %q, want %q", got, want)
	}
	for _, r := range got {
		if r == '\n' || r == '\r' || r == '\t' {
			t.Fatalf("oneLine left a control character in %q", got)
		}
	}
}

func TestOneLineTruncatesToTheLimit(t *testing.T) {
	got := oneLine("aaaa bbbb cccc", 9)
	if len([]rune(got)) != 9 {
		t.Fatalf("oneLine(_, 9) = %q (%d runes), want 9", got, len([]rune(got)))
	}
	if got[len(got)-3:] != "…" {
		t.Errorf("oneLine = %q, want it to end in an ellipsis", got)
	}
	// Under the limit, unchanged.
	if got := oneLine("short", 90); got != "short" {
		t.Errorf("oneLine truncated a short description: %q", got)
	}
	if got := oneLine("", 90); got != "" {
		t.Errorf("oneLine(\"\") = %q", got)
	}
}

// Truncation counts runes, not bytes: cutting mid-rune would emit broken UTF-8.
func TestOneLineTruncatesOnRuneBoundaries(t *testing.T) {
	got := oneLine("héllo wörld ünicode", 8)
	if len([]rune(got)) != 8 {
		t.Fatalf("oneLine = %q (%d runes), want 8", got, len([]rune(got)))
	}
	for _, r := range got {
		if r == '�' {
			t.Fatalf("oneLine produced a replacement character: %q", got)
		}
	}
}
