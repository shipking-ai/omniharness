// Package text holds the string shortening used wherever output has to fit a
// column, a row, or a model's patience.
//
// It exists because there were five separate truncate functions — in agent,
// cli, command, evaluate and tui — and four of them counted bytes. Slicing a
// UTF-8 string on a byte boundary does two things: it cuts non-ASCII text to a
// third of the length an English string gets from the same limit, and it can
// split a character in half and leave a replacement glyph behind. The fifth,
// in the TUI, counted runes and carried a comment explaining exactly that;
// nobody had carried the fix back to the other four, which is what happens to
// a bug fixed in a private copy.
package text

import (
	"strings"
	"unicode/utf8"
)

// Ellipsis marks a string that was cut.
const Ellipsis = "…"

// Clip shortens s to at most n characters, marking it with an ellipsis when it
// had to cut. Characters, not bytes: "日本語" is three, the same as "abc".
//
// A non-positive n returns the marker alone, because a caller asking for no
// room still needs to be told something was dropped.
func Clip(s string, n int) string {
	return ClipWith(s, n, Ellipsis)
}

// ClipWith is Clip with a caller-chosen marker, for the callers that append a
// note rather than an ellipsis ("\n…[output truncated]").
func ClipWith(s string, n int, marker string) string {
	if n <= 0 {
		return marker
	}
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n]) + marker
}

// Line is Clip for text going into a single-row context — a table cell, a
// session title, a status line. Newlines become spaces first, so a multi-line
// value cannot break the row it is rendered into.
func Line(s string, n int) string {
	return Clip(strings.ReplaceAll(s, "\n", " "), n)
}
