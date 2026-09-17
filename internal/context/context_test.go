package context

import (
	"strings"
	"testing"

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
