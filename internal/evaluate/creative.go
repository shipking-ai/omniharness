package evaluate

import (
	"context"
	"strings"
)

// verdictPrefix is the marker the creative director is instructed to end its
// judgement with. Parsing a declared marker rather than sniffing prose for
// words like "good" or "wrong" is the difference between a check and a guess:
// negation, hedging and quoting the brief all defeat keyword matching, and a
// misread verdict either burns repair cycles on accepted work or ships
// rejected work as a success.
const verdictPrefix = "verdict:"

// CreativeVerdictEvaluator closes the loop that gives CreativeIterate its
// name. Before it existed, a creative task matched no evaluator at all, so
// the orchestrator took "no evaluator applicable" as a PASS — the director
// could look at a render, say the title strip is missing and the mood is
// wrong, and the task completed as a success with that rejection sitting in
// its own final output. The brief/make/judge plan ran once and stopped
// whatever the judgement was.
//
// This turns the judgement into an outcome, which is all the existing
// task-level repair loop needs to run the plan again with the director's
// objection as the failure detail.
type CreativeVerdictEvaluator struct{}

func (e *CreativeVerdictEvaluator) Name() string { return "creative-verdict" }

func (e *CreativeVerdictEvaluator) Evaluate(_ context.Context, r Request) (Outcome, string, error) {
	verdict, reason, found := parseVerdict(r.Result.Summary + "\n" + r.Result.Output)
	if !found {
		// NEEDS_REVIEW completes the task, same as a missing evaluator
		// elsewhere: no verdict is not evidence of a bad asset, and failing
		// here would send perfectly good work around the repair loop three
		// times because a model omitted a line. The trace is the point.
		return NeedsReview, "no VERDICT line in the judgement; the result was not assessed against the brief", nil
	}
	switch verdict {
	case "approved":
		return Pass, "the creative director approved the result against the brief", nil
	case "revise":
		if reason == "" {
			// A rejection with no reason still fails — the work was not
			// accepted — but the detail has to say why the guidance is thin,
			// because that detail is what the repair cycle acts on.
			return Fail, "the creative director asked for a revision but gave no reason", nil
		}
		return Fail, "the creative director asked for a revision: " + reason, nil
	}
	// A verdict was written but is not one of the two words. Treating an
	// unrecognised word as approval is the failure this evaluator exists to
	// prevent, so it is reviewed rather than passed.
	return NeedsReview, "unrecognised verdict " + quote(verdict) + "; expected approved or revise", nil
}

// parseVerdict finds the last VERDICT line and splits it into the verdict
// word and the reason after it. The last one wins: a judgement that quotes
// the instruction it was given, or revises its own first assessment further
// down, must be read by its conclusion rather than its first mention.
func parseVerdict(text string) (verdict, reason string, found bool) {
	for _, line := range strings.Split(text, "\n") {
		// Models reliably decorate a final line — "**VERDICT: revise**",
		// "## VERDICT: approved", "- VERDICT: ...". Stripping the decoration
		// costs nothing and refusing it would report "no verdict" for a
		// judgement that plainly gave one.
		clean := strings.TrimSpace(strings.Trim(strings.TrimSpace(line), "#*->_ \t"))
		if len(clean) < len(verdictPrefix) ||
			!strings.EqualFold(clean[:len(verdictPrefix)], verdictPrefix) {
			continue
		}
		rest := strings.TrimSpace(clean[len(verdictPrefix):])
		word := rest
		if i := strings.IndexAny(rest, " \t—-–:,."); i >= 0 {
			word, rest = rest[:i], rest[i+1:]
		} else {
			rest = ""
		}
		verdict = strings.ToLower(strings.Trim(word, "*_`"))
		reason = strings.TrimSpace(strings.Trim(strings.TrimSpace(rest), "—-–:,*_"))
		found = true
	}
	return verdict, reason, found
}

func quote(s string) string {
	if len(s) > 40 {
		s = s[:40] + "…"
	}
	return "\"" + s + "\""
}
