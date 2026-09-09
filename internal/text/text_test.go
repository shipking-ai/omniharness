package text

import (
	"strings"
	"testing"
	"unicode/utf8"
)

// The bug this package was created to remove: four of the five truncate copies
// sliced on a byte boundary, which can cut a character in half.
func TestClipNeverSplitsACharacter(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   string
		n    int
	}{
		{"2-byte (Latin accents)", strings.Repeat("é", 40), 20},
		{"3-byte (CJK)", strings.Repeat("日本語", 20), 10},
		{"4-byte (emoji)", strings.Repeat("🙂", 20), 15},
		{"mixed widths", "résumé " + strings.Repeat("🙂", 10) + " done", 12},
	} {
		got := Clip(tc.in, tc.n)
		if !utf8.ValidString(got) {
			t.Errorf("%s: Clip(%q, %d) = %q, which is not valid UTF-8", tc.name, tc.in, tc.n, got)
		}
	}
}

// The other half of the byte bug: the same limit gave a Japanese title a third
// of the room an English one got.
func TestClipCountsCharactersNotBytes(t *testing.T) {
	got := Clip("日本語日本語日本語日本語", 10)
	if runes := utf8.RuneCountInString(strings.TrimSuffix(got, Ellipsis)); runes != 10 {
		t.Errorf("Clip kept %d characters, want 10: %q", runes, got)
	}
	if !strings.HasSuffix(got, Ellipsis) {
		t.Errorf("a clipped string must be marked: %q", got)
	}
}

func TestClipLeavesShortStringsAlone(t *testing.T) {
	for _, s := range []string{"", "short", "日本語", "🙂🙂"} {
		if got := Clip(s, 10); got != s {
			t.Errorf("Clip(%q, 10) = %q, want it unchanged", s, got)
		}
	}
	// Exactly at the limit is not truncation, so it must not be marked.
	if got := Clip("abcde", 5); got != "abcde" {
		t.Errorf("Clip at exactly the limit = %q, want no marker", got)
	}
}

// A zero or negative limit used to panic on the byte versions (s[:n] with a
// negative n). Callers compute limits from terminal width, which really does
// reach zero on a narrow pane.
func TestClipSurvivesAZeroOrNegativeLimit(t *testing.T) {
	for _, n := range []int{0, -1, -100} {
		got := Clip("some text", n)
		if got != Ellipsis {
			t.Errorf("Clip(_, %d) = %q, want just the marker", n, got)
		}
	}
}

func TestClipWithUsesTheGivenMarker(t *testing.T) {
	got := ClipWith("abcdefghij", 4, "\n…[output truncated]")
	if got != "abcd\n…[output truncated]" {
		t.Errorf("ClipWith = %q", got)
	}
	if ClipWith("abc", 10, "!!") != "abc" {
		t.Error("a string that fits must not gain a marker")
	}
}

// Line feeds single-row contexts — table cells, session titles, status lines —
// where an embedded newline breaks the layout it is rendered into.
func TestLineCollapsesNewlines(t *testing.T) {
	if got := Line("two\nlines", 20); got != "two lines" {
		t.Errorf("Line = %q, want the newline collapsed", got)
	}
	if got := Line("a\nb\nc\nd", 3); got != "a b"+Ellipsis {
		t.Errorf("Line = %q, want collapse then clip", got)
	}
	// The newline becomes a space before counting, so it takes a column.
	if got := Line("ab\ncd", 5); got != "ab cd" {
		t.Errorf("Line = %q, want the space counted in the limit", got)
	}
}
