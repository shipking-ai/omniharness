package context

import (
	"strings"
	"testing"
	"unicode/utf8"
)

// Estimate counts characters; truncateToTokens used to slice bytes. The two
// halves of one token model disagreeing meant a non-ASCII prompt was trimmed
// three to four times harder than asked, and could be cut mid-character.
func TestTruncateToTokensAgreesWithEstimate(t *testing.T) {
	for _, tc := range []struct {
		name string
		text string
	}{
		{"ascii", strings.Repeat("word ", 400)},
		{"cjk", strings.Repeat("日本語テキスト", 300)},
		{"emoji", strings.Repeat("🙂", 800)},
		{"accents", strings.Repeat("résumé ", 300)},
	} {
		const budget = 100
		got := truncateToTokens(tc.text, budget)
		if !utf8.ValidString(got) {
			t.Errorf("%s: result is not valid UTF-8", tc.name)
		}
		// The trim aims at the budget, so what comes back must not be far
		// under it. Byte-slicing returned roughly a quarter of the budget for
		// 4-byte characters, which is the failure this pins.
		if est := Estimate(got); est < budget/2 {
			t.Errorf("%s: Estimate(result) = %d tokens for a budget of %d; the trim used a different unit",
				tc.name, est, budget)
		}
		if est := Estimate(got); est > budget+1 {
			t.Errorf("%s: Estimate(result) = %d tokens, over the %d budget", tc.name, est, budget)
		}
	}
}

func TestTruncateToTokensLeavesShortTextAlone(t *testing.T) {
	for _, s := range []string{"", "short", "日本語"} {
		if got := truncateToTokens(s, 100); got != s {
			t.Errorf("truncateToTokens(%q, 100) = %q, want it unchanged", s, got)
		}
	}
}

func TestTruncateToTokensMarksWhatItCut(t *testing.T) {
	got := truncateToTokens(strings.Repeat("日本語", 500), 100)
	if !strings.HasSuffix(got, truncationNote) {
		t.Errorf("a trimmed prompt must say so; got tail %q", got[max(0, len(got)-40):])
	}
}

// A budget smaller than the note itself still must not produce broken UTF-8.
func TestTruncateToTokensSurvivesATinyBudget(t *testing.T) {
	for _, tokens := range []int64{0, 1, 2} {
		got := truncateToTokens(strings.Repeat("🙂", 100), tokens)
		if !utf8.ValidString(got) {
			t.Errorf("budget %d produced invalid UTF-8: %q", tokens, got)
		}
	}
}
