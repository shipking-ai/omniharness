package context

import (
	"strings"
	"testing"

	"omniharness/internal/gateway"
	"omniharness/internal/task"
)

func TestComposeBasic(t *testing.T) {
	c := NewComposer(Limits{})
	out, err := c.Compose(Input{
		Spec:    task.Spec{Prompt: "Implement a parser."},
		Profile: task.Profile{Complexity: task.ComplexityMedium, Domain: task.DomainSoftware},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Messages) < 2 {
		t.Fatalf("expected system+user, got %d", len(out.Messages))
	}
	if out.Messages[0].Role != "system" {
		t.Fatalf("first message %q", out.Messages[0].Role)
	}
	if !strings.Contains(out.Messages[0].Content, "TASK PROFILE") {
		t.Fatalf("system prompt missing profile: %q", out.Messages[0].Content)
	}
	if out.Messages[1].Role != "user" || !strings.Contains(out.Messages[1].Content, "parser") {
		t.Fatalf("user message: %+v", out.Messages[1])
	}
}

func TestProjectInstructionsIncluded(t *testing.T) {
	c := NewComposer(Limits{})
	out, _ := c.Compose(Input{
		Spec:                task.Spec{Prompt: "x"},
		ProjectInstructions: []string{"always run tests", "use gofmt"},
	})
	if !strings.Contains(out.Messages[0].Content, "always run tests") {
		t.Fatal("project instructions missing")
	}
}

func TestFilesIncludedAndCapped(t *testing.T) {
	c := NewComposer(Limits{})
	big := strings.Repeat("x", 40_000)
	out, _ := c.Compose(Input{
		Spec:  task.Spec{Prompt: "look at these"},
		Files: []FileRef{{Path: "a.txt", Content: big}, {Path: "b.txt", Content: "small"}},
	})
	joined := out.Messages[1].Content
	if !strings.Contains(joined, "a.txt") || !strings.Contains(joined, "b.txt") {
		t.Fatal("files missing from user message")
	}
	if !strings.Contains(joined, "truncated") {
		t.Fatal("large file should be truncated")
	}
}

func TestHistoryCondensedAtLimit(t *testing.T) {
	c := NewComposer(Limits{CondenseAt: 200, MaxTokens: 1000})
	var history []Message
	for i := 0; i < 20; i++ {
		history = append(history, Message{Role: "assistant", Content: strings.Repeat("word ", 50)})
	}
	out, err := c.Compose(Input{
		Spec:    task.Spec{Prompt: "continue"},
		History: history,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !out.Condensed {
		t.Fatal("expected condensation")
	}
	if out.Dropped == 0 {
		t.Fatal("expected dropped messages")
	}
	if out.Tokens > 1000 {
		t.Fatalf("tokens %d exceed cap", out.Tokens)
	}
}

func TestEstimate(t *testing.T) {
	if Estimate("") != 0 {
		t.Fatal("empty estimate")
	}
	if Estimate("hello world") < 1 {
		t.Fatal("non-empty estimate")
	}
	// 4000 runes ≈ 1000 tokens.
	if Estimate(strings.Repeat("a", 4000)) != 1000 {
		t.Fatalf("estimate = %d", Estimate(strings.Repeat("a", 4000)))
	}
}

func TestSummarize(t *testing.T) {
	s := Summarize([]Message{
		{Role: "assistant", Content: "I read the parser and fixed the bug in lexer.go."},
		{Role: "assistant", Content: strings.Repeat("long ", 500)},
	}, 400)
	if !strings.Contains(s, "lexer.go") {
		t.Fatalf("summary missing key content: %q", s)
	}
	if len(s) > 600 {
		t.Fatalf("summary too long: %d", len(s))
	}
}

// "MaxTokens caps the total composed context" was only true of the history.
// The system prompt and the file attachments were added without ever being
// checked, so a 1000-token limit composed 300,627 tokens — sixty files each
// under the 30k per-file cap, none of them counted against the budget — and
// Condensed stayed false, so nothing said the context had overflowed.
func TestComposeStaysWithinMaxTokens(t *testing.T) {
	c := NewComposer(Limits{MaxTokens: 1000})

	var files []FileRef
	for i := 0; i < 60; i++ {
		files = append(files, FileRef{Path: "big.go", Content: strings.Repeat("x", 20_000)})
	}
	out, err := c.Compose(Input{Spec: task.Spec{Prompt: "do the thing"}, Files: files})
	if err != nil {
		t.Fatal(err)
	}
	if out.Tokens > 1000 {
		t.Errorf("composed %d tokens against a 1000-token cap", out.Tokens)
	}
	if !out.Condensed {
		t.Error("dropping attachments must be reported, not silent")
	}
	if out.Dropped == 0 {
		t.Error("dropped attachments must be counted")
	}

	// An oversized system prompt is trimmed rather than sent whole: the task
	// prompt is not discretionary, so it is the system text that gives way.
	out, err = c.Compose(Input{
		Spec:         task.Spec{Prompt: "keep me"},
		SystemPrompt: strings.Repeat("y", 500_000),
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Tokens > 1000 {
		t.Errorf("oversized system prompt composed %d tokens against a 1000-token cap", out.Tokens)
	}
	if !strings.Contains(out.Messages[len(out.Messages)-1].Content, "keep me") {
		t.Error("the task prompt must survive trimming")
	}

	// No cap configured still means no cap.
	unlimited := NewComposer(Limits{})
	out, err = unlimited.Compose(Input{Spec: task.Spec{Prompt: "x"}, Files: files})
	if err != nil {
		t.Fatal(err)
	}
	if out.Dropped != 0 {
		t.Errorf("an unlimited composer dropped %d attachments", out.Dropped)
	}
}

// The criteria the deepening pass produces were computed, stored on the
// Profile, and read by nothing — the same dead-signal shape Ambiguity and
// ApprovalRecommended used to have. Every agent should see what "done"
// means for this specific task.
func TestAcceptanceCriteriaReachTheSystemPrompt(t *testing.T) {
	c := NewComposer(Limits{})
	out, _ := c.Compose(Input{
		Spec: task.Spec{Prompt: "x"},
		Profile: task.Profile{
			Complexity:         task.ComplexityHigh,
			AcceptanceCriteria: []string{"the parser handles empty input", "go test ./... passes"},
		},
	})
	sys := out.Messages[0].Content
	if !strings.Contains(sys, "ACCEPTANCE CRITERIA") {
		t.Fatalf("no acceptance criteria section in the system prompt: %q", sys)
	}
	for _, want := range []string{"the parser handles empty input", "go test ./... passes"} {
		if !strings.Contains(sys, want) {
			t.Errorf("system prompt missing criterion %q", want)
		}
	}
}

// A profile with no criteria (the common case — the deepening pass is off by
// default) must not grow an empty, confusing section.
func TestNoAcceptanceCriteriaMeansNoSection(t *testing.T) {
	c := NewComposer(Limits{})
	out, _ := c.Compose(Input{
		Spec:    task.Spec{Prompt: "x"},
		Profile: task.Profile{Complexity: task.ComplexityLow},
	})
	if strings.Contains(out.Messages[0].Content, "ACCEPTANCE CRITERIA") {
		t.Fatalf("empty criteria produced a section anyway: %q", out.Messages[0].Content)
	}
}

// --- prompt-prefix stability -------------------------------------------------

// A provider caches a prompt by matching a prefix, so the first byte that
// changes between two turns is where the cache stops paying. The summary is
// the only part of this prompt that changes during a run — it is rewritten on
// every condensation — so everything else has to sit in front of it.
//
// This is a cost invariant, not a formatting preference: with the summary in
// the middle, every condensation re-charged the task profile and the
// acceptance criteria as well as itself, for the rest of the run.
func TestSystemPromptKeepsStablePrefixWhenSummaryChanges(t *testing.T) {
	c := NewComposer(Limits{})
	in := Input{
		Spec:                task.Spec{Prompt: "Implement a parser."},
		SystemPrompt:        "You are an implementer.",
		ProjectInstructions: []string{"run go test ./... before finishing"},
		Profile: task.Profile{
			Complexity:         task.ComplexityMedium,
			Domain:             task.DomainSoftware,
			AcceptanceCriteria: []string{"the parser round-trips"},
		},
	}

	in.Summary = "read three files, found the lexer"
	first, err := c.Compose(in)
	if err != nil {
		t.Fatal(err)
	}
	in.Summary = "read nine files, rewrote the lexer, tests now fail on the second case"
	second, err := c.Compose(in)
	if err != nil {
		t.Fatal(err)
	}

	a, b := first.Messages[0].Content, second.Messages[0].Content
	shared := 0
	for shared < len(a) && shared < len(b) && a[shared] == b[shared] {
		shared++
	}
	prefix := a[:shared]

	// Everything that did not change must still be inside the shared prefix.
	for _, stable := range []string{
		"You are an implementer.",
		"PROJECT INSTRUCTIONS",
		"go test ./...",
		"TASK PROFILE",
		"ACCEPTANCE CRITERIA",
		"the parser round-trips",
	} {
		if !strings.Contains(prefix, stable) {
			t.Errorf("%q fell outside the cacheable prefix — a changed summary should not move it\nprefix: %q", stable, prefix)
		}
	}

	// And the summary itself must be the tail that differs, not something in
	// the middle that drags the rest along with it.
	if !strings.HasSuffix(strings.TrimSpace(a), "found the lexer") {
		t.Errorf("the summary must be last in the system prompt, got tail %q", tail(a))
	}
	if strings.Contains(prefix, "found the lexer") {
		t.Errorf("the changed summary should not be in the shared prefix: %q", prefix)
	}
}

// With no summary at all the prompt must still end on the stable frame, so a
// run that has not condensed yet shares its prefix with one that has.
func TestSystemPromptWithoutSummaryIsAPrefixOfOneWithSummary(t *testing.T) {
	c := NewComposer(Limits{})
	in := Input{
		Spec:         task.Spec{Prompt: "Implement a parser."},
		SystemPrompt: "You are an implementer.",
		Profile:      task.Profile{Complexity: task.ComplexityMedium, Domain: task.DomainSoftware},
	}
	bare, _ := c.Compose(in)
	in.Summary = "condensed once"
	withSummary, _ := c.Compose(in)

	if !strings.HasPrefix(withSummary.Messages[0].Content, bare.Messages[0].Content) {
		t.Fatalf("adding a summary rewrote the prompt instead of appending to it:\nbare: %q\nwith: %q",
			bare.Messages[0].Content, withSummary.Messages[0].Content)
	}
}

func tail(s string) string {
	if len(s) > 80 {
		return s[len(s)-80:]
	}
	return s
}

// --- which end of history survives -------------------------------------------

// The recent turns are the ones the next step depends on. Keeping the opening
// exchange and dropping what just happened leaves an agent that cannot see
// what its last tool call returned — so it calls it again, which is how a run
// starts circling.
func TestHistoryKeepsTheNewestTurns(t *testing.T) {
	var hist []Message
	for _, tag := range []string{"oldest", "second", "third", "newest"} {
		hist = append(hist, Message{Role: "user", Content: tag + " " + strings.Repeat("x", 400)})
	}
	c := NewComposer(Limits{MaxTokens: 260, CondenseAt: 100})
	out, err := c.Compose(Input{
		Spec:    task.Spec{Prompt: "go"},
		Profile: task.Profile{Complexity: task.ComplexityLow},
		History: hist,
	})
	if err != nil {
		t.Fatal(err)
	}

	joined := ""
	for _, m := range out.Messages {
		joined += m.Content + "\n"
	}
	if !strings.Contains(joined, "newest") {
		t.Errorf("the most recent turn was dropped:\n%s", joined)
	}
	if strings.Contains(joined, "oldest") {
		t.Errorf("the oldest turn survived while newer ones did not:\n%s", joined)
	}
	if !out.Condensed || out.Dropped == 0 {
		t.Errorf("dropping history must be reported: condensed=%v dropped=%d", out.Condensed, out.Dropped)
	}
}

// What survives must still be in the order it happened.
func TestKeptHistoryStaysChronological(t *testing.T) {
	var hist []Message
	for _, tag := range []string{"one", "two", "three", "four", "five"} {
		hist = append(hist, Message{Role: "user", Content: tag + " " + strings.Repeat("x", 200)})
	}
	c := NewComposer(Limits{MaxTokens: 400})
	out, _ := c.Compose(Input{Spec: task.Spec{Prompt: "go"}, History: hist})

	var seen []string
	for _, m := range out.Messages {
		for _, tag := range []string{"one", "two", "three", "four", "five"} {
			if strings.HasPrefix(m.Content, tag+" ") {
				seen = append(seen, tag)
			}
		}
	}
	order := map[string]int{"one": 1, "two": 2, "three": 3, "four": 4, "five": 5}
	for i := 1; i < len(seen); i++ {
		if order[seen[i-1]] > order[seen[i]] {
			t.Fatalf("history came back out of order: %v", seen)
		}
	}
}

// The wire format rejects a tool message with no matching assistant tool_calls
// before it, so a cut that lands between the two produces a request the
// gateway refuses outright. The boundary has to move back past the assistant
// message that owns the results, even though that means keeping less.
func TestHistoryNeverStartsOnAnOrphanedToolResult(t *testing.T) {
	call := gateway.ToolCall{ID: "t1", Type: "function"}
	hist := []Message{
		{Role: "user", Content: "old question " + strings.Repeat("x", 600)},
		{Role: "assistant", Content: "calling a tool", ToolCalls: []gateway.ToolCall{call}},
		{Role: "tool", ToolCallID: "t1", Name: "read_file", Content: "file contents " + strings.Repeat("y", 300)},
		{Role: "assistant", Content: "here is the answer"},
	}
	// A budget that lands the natural cut in the middle of the tool exchange.
	for _, limit := range []int64{90, 100, 110, 120, 140, 160, 200} {
		c := NewComposer(Limits{MaxTokens: limit})
		out, err := c.Compose(Input{Spec: task.Spec{Prompt: "go"}, History: hist})
		if err != nil {
			t.Fatal(err)
		}
		// Find the first history message in the output and check it is not a
		// tool result. Anything else is a request the gateway will reject.
		for _, m := range out.Messages {
			if m.Role == "tool" {
				t.Fatalf("limit %d produced an orphaned tool result as the first history message", limit)
			}
			if m.Role == "assistant" || (m.Role == "user" && strings.HasPrefix(m.Content, "old question")) {
				break // reached real history, and it was not a tool message
			}
		}
	}
}

// A tool result kept at all must still have its assistant message with it.
func TestKeptToolResultKeepsItsRequest(t *testing.T) {
	call := gateway.ToolCall{ID: "t1", Type: "function"}
	hist := []Message{
		{Role: "user", Content: "q " + strings.Repeat("x", 2000)},
		{Role: "assistant", Content: "calling", ToolCalls: []gateway.ToolCall{call}},
		{Role: "tool", ToolCallID: "t1", Name: "read_file", Content: "result"},
	}
	c := NewComposer(Limits{MaxTokens: 200})
	out, _ := c.Compose(Input{Spec: task.Spec{Prompt: "go"}, History: hist})

	sawAssistant := false
	for _, m := range out.Messages {
		if m.Role == "assistant" && len(m.ToolCalls) > 0 {
			sawAssistant = true
		}
		if m.Role == "tool" && !sawAssistant {
			t.Fatal("a tool result was kept without the assistant message that requested it")
		}
	}
}

// --- the reduction ladder -----------------------------------------------------

func toolExchange(tag string, resultSize int) []Message {
	call := gateway.ToolCall{ID: "t-" + tag, Type: "function"}
	return []Message{
		{Role: "assistant", Content: "calling read_file for " + tag, ToolCalls: []gateway.ToolCall{call}},
		{Role: "tool", ToolCallID: "t-" + tag, Name: "read_file", Content: tag + "-body " + strings.Repeat("z", resultSize)},
	}
}

// The things in a context are not equally worth keeping. A tool result from
// twenty steps ago is bulk the model has already extracted what it needs from;
// the turn that produced it is the record that it happened. So the result goes
// first, and the turn survives.
func TestToolResultsAreElidedBeforeTurnsAreDropped(t *testing.T) {
	var hist []Message
	for _, tag := range []string{"first", "second", "third"} {
		hist = append(hist, toolExchange(tag, 1200)...)
	}
	// Room for the turns but not for their payloads.
	c := NewComposer(Limits{MaxTokens: 400})
	out, err := c.Compose(Input{Spec: task.Spec{Prompt: "go"}, History: hist})
	if err != nil {
		t.Fatal(err)
	}

	if out.Tier != TierToolResults {
		t.Fatalf("tier = %q, want %q — turns were dropped before payloads were", out.Tier, TierToolResults)
	}
	if out.Elided == 0 {
		t.Fatal("nothing was elided")
	}
	if out.Dropped != 0 {
		t.Fatalf("dropped %d turns when eliding was enough", out.Dropped)
	}

	var joined string
	for _, m := range out.Messages {
		joined += m.Content + "\n"
	}
	// The record that each call happened survives.
	for _, tag := range []string{"first", "second", "third"} {
		if !strings.Contains(joined, "calling read_file for "+tag) {
			t.Errorf("the %s call was lost — eliding a payload should not cost the record of the call", tag)
		}
	}
	// The elision says what it replaced, so the model can go get it again
	// rather than reasoning from a gap it cannot see.
	if !strings.Contains(joined, "elided to save context") {
		t.Errorf("an elided result must say so:\n%s", joined)
	}
	if !strings.Contains(joined, "read_file") {
		t.Error("the note should name the tool that produced the result")
	}
}

// The newest result is still being worked with, so the oldest goes first.
func TestElisionStartsWithTheOldestResult(t *testing.T) {
	var hist []Message
	hist = append(hist, toolExchange("oldest", 2000)...)
	hist = append(hist, toolExchange("newest", 2000)...)

	c := NewComposer(Limits{MaxTokens: 620})
	out, _ := c.Compose(Input{Spec: task.Spec{Prompt: "go"}, History: hist})

	var joined string
	for _, m := range out.Messages {
		joined += m.Content + "\n"
	}
	if out.Elided != 1 {
		t.Fatalf("elided %d results, wanted exactly the one that was needed", out.Elided)
	}
	if strings.Contains(joined, "oldest-body") {
		t.Error("the oldest result should have been the one elided")
	}
	if !strings.Contains(joined, "newest-body") {
		t.Errorf("the newest result is still being worked with and should survive:\n%s", joined)
	}
}

// When eliding is not enough, the ladder goes on to dropping turns — and says
// which rung it reached, because a run that used to fit on elision and now
// drops turns has got worse in a way a token count does not show.
func TestLadderFallsThroughToDroppingTurns(t *testing.T) {
	var hist []Message
	for _, tag := range []string{"a", "b", "c", "d", "e", "f"} {
		hist = append(hist, toolExchange(tag, 3000)...)
	}
	c := NewComposer(Limits{MaxTokens: 120})
	out, _ := c.Compose(Input{Spec: task.Spec{Prompt: "go"}, History: hist})

	if out.Tier != TierDropTurns {
		t.Fatalf("tier = %q, want %q", out.Tier, TierDropTurns)
	}
	if out.Dropped == 0 {
		t.Fatal("turns should have been dropped at this budget")
	}
}

// The bottom rung means something different: the limit is too small for the
// task itself, not for its history, and nothing below it is recoverable by
// shedding context.
func TestLadderBottomsOutOnTheSystemPrompt(t *testing.T) {
	c := NewComposer(Limits{MaxTokens: 12})
	out, err := c.Compose(Input{
		Spec:         task.Spec{Prompt: strings.Repeat("a long task description ", 40)},
		SystemPrompt: strings.Repeat("a long system prompt ", 40),
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Tier != TierTrimPrompt {
		t.Fatalf("tier = %q, want %q", out.Tier, TierTrimPrompt)
	}
}

// A context that fits reports no tier at all, so "which rung" is only ever
// asked about runs that needed one.
func TestFittingContextReportsNoTier(t *testing.T) {
	out, _ := NewComposer(Limits{MaxTokens: 100000}).Compose(Input{
		Spec:    task.Spec{Prompt: "go"},
		History: toolExchange("one", 50),
	})
	if out.Tier != TierNone {
		t.Fatalf("tier = %q, want none", out.Tier)
	}
	if out.Elided != 0 || out.Dropped != 0 || out.Condensed {
		t.Fatalf("nothing should have been reduced: %+v", out)
	}
}

// Eliding must not break the pairing the wire format requires: the tool
// message stays where it was, with its content replaced.
func TestElisionKeepsToolMessagesPairedWithTheirRequests(t *testing.T) {
	var hist []Message
	for _, tag := range []string{"a", "b", "c"} {
		hist = append(hist, toolExchange(tag, 1500)...)
	}
	out, _ := NewComposer(Limits{MaxTokens: 500}).Compose(Input{Spec: task.Spec{Prompt: "go"}, History: hist})

	sawCall := false
	for _, m := range out.Messages {
		if m.Role == "assistant" && len(m.ToolCalls) > 0 {
			sawCall = true
		}
		if m.Role == "tool" {
			if !sawCall {
				t.Fatal("a tool message appeared with no assistant tool_calls before it")
			}
			if m.Content == "" {
				t.Fatal("an elided result must carry a note, not an empty body")
			}
		}
	}
}
