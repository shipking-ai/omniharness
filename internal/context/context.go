// Package context builds model-specific context for agents. It never sends
// the whole repository or conversation to every model: it selects what is
// relevant, estimates token usage, and condenses when limits approach.
package context

import (
	"fmt"
	"strconv"
	"strings"

	"omniharness/internal/gateway"
	"omniharness/internal/task"
)

// Message is a single conversational message.
type Message struct {
	Role       string `json:"role"` // user | assistant | tool
	Content    string `json:"content"`
	ToolCallID string `json:"toolCallId,omitempty"`
	Name       string `json:"name,omitempty"` // tool name for tool results
	// Images travel with the message so an observation survives composition.
	// Carried opaquely: the composer measures and condenses text, and has no
	// business decoding image bytes.
	Images []gateway.ImageRef `json:"-"`
	// ToolCalls are the calls an assistant message requested. They must
	// survive composition: the wire format rejects a tool message with no
	// matching assistant tool_calls before it, so dropping them here turns
	// every follow-up request into orphaned tool results.
	ToolCalls []gateway.ToolCall `json:"-"`
}

// FileRef is a file selected for inclusion in context.
type FileRef struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// Input to the composer.
type Input struct {
	Spec                task.Spec
	Profile             task.Profile
	ProjectInstructions []string
	Files               []FileRef
	History             []Message // prior conversation (assistant messages + tool results)
	Summary             string    // running condensation summary
	// SystemPrompt is the base system prompt (role instructions etc.).
	SystemPrompt string
}

// Tier is how far down the reduction ladder composition had to go to fit.
//
// The ladder exists because the things in a context are not equally worth
// keeping, and a single threshold treats them as if they were. A tool result
// from twenty steps ago is bulk the model has already extracted what it needs
// from; the turn that produced it is the record that it happened. Losing the
// first costs almost nothing and buys a lot of room, so it goes first.
type Tier string

const (
	// TierNone: everything fitted.
	TierNone Tier = ""
	// TierToolResults: the bodies of older tool results were replaced with a
	// note saying how much was elided. The messages stay — removing them would
	// orphan the assistant turns that requested them — but their bulk goes.
	// This is the cheapest thing in a context to lose.
	TierToolResults Tier = "tool_results"
	// TierDropTurns: whole turns were dropped from the start of history,
	// oldest first, after eliding tool results was not enough.
	TierDropTurns Tier = "drop_turns"
	// TierTrimPrompt: even the system prompt and the task did not fit, so the
	// system prompt was trimmed. Reaching here means the limit is too small
	// for the task rather than the history being too long, and it is worth
	// surfacing differently for that reason.
	TierTrimPrompt Tier = "trim_prompt"
)

// Output of the composer.
type Output struct {
	Messages  []Message
	Tokens    int64
	Condensed bool
	Dropped   int
	// Tier is the furthest step down the ladder this composition needed. It is
	// reported so the interface can say which one fired and so a regression
	// can be seen: a run that used to fit on tool-result elision and now drops
	// turns has got worse in a way total token count alone does not show.
	Tier Tier
	// Elided counts tool results whose bodies were replaced.
	Elided int
}

// Limits control composition behavior.
type Limits struct {
	// MaxTokens caps the total composed context. 0 = no cap.
	MaxTokens int64
	// CondenseAt is the token threshold at which old history is condensed.
	CondenseAt int64
}

// Composer assembles context for one model call.
type Composer struct {
	Limits Limits
}

// NewComposer returns a composer with the given limits.
func NewComposer(l Limits) *Composer { return &Composer{Limits: l} }

// Compose builds the message list for a model call.
func (c *Composer) Compose(in Input) (Output, error) {
	var out Output
	limit := c.Limits.MaxTokens
	if limit <= 0 {
		limit = 1 << 20 // practical safety cap
	}

	sys := in.SystemPrompt
	if sys == "" {
		sys = "You are a capable agent working on a task. Use the provided tools when they help."
	}
	if len(in.ProjectInstructions) > 0 {
		sys += "\n\nPROJECT INSTRUCTIONS:\n- " + strings.Join(in.ProjectInstructions, "\n- ")
	}
	if p := in.Profile; p.Complexity != "" {
		sys += "\n\nTASK PROFILE: complexity=" + string(p.Complexity) +
			" domain=" + string(p.Domain) +
			" risk=" + string(p.Risk) +
			" verification=" + string(p.Verification)
		if len(p.Tools) > 0 {
			sys += " tools=" + strings.Join(p.Tools, ",")
		}
		// What "done" means for this specific task, when the optional
		// deepening pass produced it (task.DeepAnalyzer). Every role sees
		// it: the implementer works toward it, and the reviewer on a verify
		// step has something concrete to check the result against rather
		// than its own idea of complete.
		if len(p.AcceptanceCriteria) > 0 {
			sys += "\n\nACCEPTANCE CRITERIA (this task is done when all of these hold):\n- " +
				strings.Join(p.AcceptanceCriteria, "\n- ")
		}
	}

	// The running summary goes last, and that ordering is load-bearing rather
	// than cosmetic.
	//
	// Providers cache a prompt by matching a prefix, so everything after the
	// first byte that changes is re-read and re-charged. The summary is the
	// one part of this prompt that changes during a run: it is rewritten every
	// time history is condensed. Sitting where it used to — between the
	// project instructions and the task profile — it invalidated the profile
	// and the acceptance criteria along with itself, on every condensation,
	// for the rest of the run.
	//
	// Placed last, the whole stable frame survives: base prompt, project
	// instructions, profile, acceptance criteria. Only the summary is re-read.
	if in.Summary != "" {
		sys += "\n\nSUMMARY OF PRIOR WORK:\n" + in.Summary
	}

	// The system prompt and the task prompt are not discretionary — the run is
	// meaningless without them — so if those alone exceed the limit the system
	// prompt is trimmed rather than the request being silently mis-sent.
	prompt := in.Spec.Prompt
	if reserved := Estimate(sys) + Estimate(prompt); reserved > limit {
		if room := limit - Estimate(prompt); room > 0 {
			sys = truncateToTokens(sys, room)
		} else {
			sys = truncateToTokens(sys, limit/4)
		}
		out.Condensed = true
		// The bottom of the ladder, and it means something different from the
		// tiers above: the limit is too small for the task itself, not merely
		// too small for its history. Nothing below this is recoverable by
		// shedding context.
		out.Tier = TierTrimPrompt
	}
	out.Messages = append(out.Messages, Message{Role: "system", Content: sys})
	out.Tokens += Estimate(sys)

	user := prompt
	if len(in.Files) > 0 {
		var b strings.Builder
		b.WriteString(user)
		b.WriteString("\n\nRelevant files:\n")
		// Attachments are bounded by what is left, not only per file. Capping
		// each file at 30k and never counting the total is how a 1000-token
		// limit produced a 300,000-token context: sixty files each under the
		// per-file cap, none of them checked against the budget.
		used := out.Tokens + Estimate(user)
		for i, f := range in.Files {
			content := f.Content
			if len(content) > 30_000 {
				content = content[:30_000] + "\n...[truncated]"
			}
			block := "\n===== " + f.Path + " =====\n" + content + "\n===== end " + f.Path + " =====\n"
			t := Estimate(block)
			if used+t > limit {
				out.Condensed = true
				out.Dropped += len(in.Files) - i
				b.WriteString("\n...[" + itoa(len(in.Files)-i) + " more files omitted to stay within the context limit]\n")
				break
			}
			b.WriteString(block)
			used += t
		}
		user = b.String()
	}
	out.Messages = append(out.Messages, Message{Role: "user", Content: user})
	out.Tokens += Estimate(user)

	// Fit history newest-first, then restore chronological order.
	//
	// This used to walk oldest-first and stop at the cap, which kept the
	// opening exchange and dropped everything recent — so a long run lost the
	// tool results it had just received while carrying turns it had already
	// acted on. That is the wrong end: the recent turns are the ones the next
	// step depends on, and an agent that cannot see what its last tool call
	// returned repeats it, which is how a run starts circling.
	// Tier one: elide the bodies of older tool results before dropping
	// anything. A tool result is the bulkiest thing in a trajectory and the
	// least useful to re-read — the model already acted on it, and what it
	// needs from that turn is that the call happened and roughly what came
	// back. Dropping a whole turn to save the same room costs the record of a
	// decision; eliding a result costs a page of file contents.
	history := in.History
	if base := out.Tokens; base+historyTokens(history) > limit {
		elided, n := elideToolResults(history, limit-base)
		if n > 0 {
			history = elided
			out.Elided = n
			out.Tier = TierToolResults
			out.Condensed = true
		}
	}

	// Tier two: drop whole turns, oldest first, if eliding was not enough.
	kept, dropped := c.fitNewestFirst(history, limit, &out.Tokens)
	if dropped > 0 {
		out.Tier = TierDropTurns
		out.Condensed = true
		out.Dropped += dropped
		// The marker stands where the dropped turns were, so the model can see
		// that the history it is reading is not the whole history. Without it
		// the transcript looks complete and simply begins in the middle.
		if c.Limits.CondenseAt > 0 && out.Tokens > c.Limits.CondenseAt {
			kept = append([]Message{{Role: "system", Content: condensedMarker()}}, kept...)
		}
	}
	out.Messages = append(out.Messages, kept...)
	return out, nil
}

// fitNewestFirst keeps as much of the tail of history as the budget allows and
// returns it in chronological order, with the number of messages dropped.
//
// Tool results cannot be separated from the assistant message that requested
// them: the wire format rejects a tool message with no matching assistant
// tool_calls before it, so a cut that lands between the two produces a request
// the gateway refuses outright. A boundary that would orphan tool results is
// therefore moved back past the assistant message that owns them, giving up a
// little more history to keep what remains sendable.
func (c *Composer) fitNewestFirst(history []Message, limit int64, tokens *int64) ([]Message, int) {
	base := *tokens // everything already composed: system prompt, user message, files
	start := len(history)
	used := base
	for i := len(history) - 1; i >= 0; i-- {
		t := Estimate(history[i].Content)
		if used+t > limit {
			break
		}
		used += t
		start = i
	}
	// Walk the boundary back until the first kept message is not an orphaned
	// tool result. Every step past an assistant message that requested tool
	// calls has to take that message too, so this drops rather than adds.
	for start < len(history) && history[start].Role == "tool" {
		start++
	}
	if start >= len(history) {
		// Nothing can be kept without orphaning something. Dropping all of it
		// is correct: a partial tool exchange is not shorter history, it is a
		// request the gateway rejects.
		return nil, len(history)
	}
	// Re-measure rather than reuse `used`: the orphan walk above may have
	// dropped messages that were already counted into it.
	*tokens = base
	for _, m := range history[start:] {
		*tokens += Estimate(m.Content)
	}
	return history[start:], start
}

// truncateToTokens trims text to approximately the given token budget. The
// estimate is characters-per-token, so this is proportional rather than exact —
// enough to keep an oversized prompt from blowing the window.
// Characters, not bytes, because Estimate counts characters
// (len([]rune(s))/charsPerToken) and the two halves of one token model have to
// agree. Slicing bytes made this trim three to four times more aggressive than
// intended on CJK or emoji text — the caller asked for a budget Estimate would
// have measured as well within the window — and could cut a character in half,
// putting invalid UTF-8 into a model's context.
func truncateToTokens(sTxt string, tokens int64) string {
	if tokens <= 0 {
		return ""
	}
	max := int(tokens * charsPerToken)
	runes := []rune(sTxt)
	if len(runes) <= max {
		return sTxt
	}
	noteLen := len([]rune(truncationNote))
	if max <= noteLen {
		return string(runes[:max])
	}
	return string(runes[:max-noteLen]) + truncationNote
}

// charsPerToken mirrors the ratio Estimate uses.
const charsPerToken = 4

const truncationNote = "\n...[truncated to fit the context limit]"

func itoa(n int) string {
	return strconv.Itoa(n)
}

func condensedMarker() string {
	return "[Earlier conversation condensed. Rely on the SUMMARY OF PRIOR WORK and continue from the most recent state.]"
}

// Estimate approximates token count for a string (English-biased: ~4 chars
// per token, rune-based so it degrades gracefully for other scripts).
func Estimate(s string) int64 {
	if s == "" {
		return 0
	}
	n := int64(len([]rune(s)) / charsPerToken)
	if n == 0 {
		return 1
	}
	return n
}

// Summarize produces a compact summary of messages (used by the agent loop to
// maintain the running condensation summary).
func Summarize(messages []Message, maxChars int) string {
	if maxChars <= 0 {
		maxChars = 2000
	}
	var b strings.Builder
	for _, m := range messages {
		content := strings.TrimSpace(m.Content)
		if content == "" {
			continue
		}
		if len(content) > 300 {
			content = content[:300] + "…"
		}
		line := m.Role + ": " + content
		if b.Len()+len(line) > maxChars {
			break
		}
		b.WriteString(line)
		b.WriteString("\n")
	}
	return strings.TrimSpace(b.String())
}

// historyTokens is what a whole history would cost.
func historyTokens(history []Message) int64 {
	var n int64
	for _, m := range history {
		n += Estimate(m.Content)
	}
	return n
}

// elideToolResults replaces the bodies of the oldest tool results with a note
// saying what was there, stopping as soon as the history fits the room it is
// given. It returns the rewritten history and how many results it elided.
//
// The messages themselves stay. Removing a tool message would orphan the
// assistant turn that requested it — the wire format rejects the pairing —
// and the fact that a call was made is exactly the part worth keeping. What
// goes is the payload: a file listing, a diff, a page of output the model has
// already read once and acted on.
//
// Oldest first, because a recent result is still being worked with.
func elideToolResults(history []Message, room int64) ([]Message, int) {
	if room < 0 {
		room = 0
	}
	total := historyTokens(history)
	if total <= room {
		return history, 0
	}
	out := append([]Message(nil), history...)
	elided := 0
	for i := range out {
		if total <= room {
			break
		}
		if out[i].Role != "tool" || out[i].Content == "" {
			continue
		}
		before := Estimate(out[i].Content)
		note := elidedNote(out[i].Name, len(out[i].Content))
		after := Estimate(note)
		if after >= before {
			// Nothing to gain: the note would be as long as the result.
			continue
		}
		out[i].Content = note
		total -= before - after
		elided++
	}
	if elided == 0 {
		return history, 0
	}
	return out, elided
}

// elidedNote is what stands in for a tool result that was dropped. It names
// the tool and the size, because "a result was here and it was large" is the
// part the model can still act on — it can call the tool again if it turns out
// to need the detail, and silently shortening the content would leave it
// reasoning from a truncated payload without knowing it.
func elidedNote(tool string, size int) string {
	if tool == "" {
		tool = "tool"
	}
	return fmt.Sprintf("[%s result elided to save context: %d bytes. Call it again if you need the detail.]", tool, size)
}
