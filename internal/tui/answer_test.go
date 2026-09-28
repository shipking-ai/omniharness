package tui

import (
	"strings"
	"testing"
	"unicode/utf8"

	"omniharness/internal/event"
	"omniharness/internal/task"
)

const finalAnswer = "the fallback now retries once"

func completed(summary string) eventMsg {
	return eventMsg{E: event.New(&event.TaskCompletedData{Summary: summary})}
}

func doneTask(summary string) taskDoneMsg {
	return taskDoneMsg{Task: &task.Task{Status: task.StatusCompleted, Result: &task.Result{Summary: summary}}}
}

// finishStream runs the typing animation to its end.
func finishStream(t *testing.T, m *Model) *Model {
	t.Helper()
	for i := 0; i < 10000 && m.streamFull != ""; i++ {
		m, _ = update(t, m, tickMsg{})
	}
	if m.streamFull != "" {
		t.Fatal("the answer animation never finished")
	}
	return m
}

func startedModel(t *testing.T) *Model {
	t.Helper()
	m, _ := newTestModel(t)
	m.width, m.height = 100, 40
	m, _ = update(t, m, taskStartedMsg{})
	return m
}

func TestAnswerIsDrawnOnceWhicheverSignalArrivesFirst(t *testing.T) {
	orders := map[string]func(*testing.T, *Model) *Model{
		"event then done": func(t *testing.T, m *Model) *Model {
			m, _ = update(t, m, completed(finalAnswer))
			m, _ = update(t, m, doneTask(finalAnswer))
			return m
		},
		"done then event": func(t *testing.T, m *Model) *Model {
			m, _ = update(t, m, doneTask(finalAnswer))
			m, _ = update(t, m, completed(finalAnswer))
			return m
		},
	}
	for name, deliver := range orders {
		t.Run(name, func(t *testing.T) {
			m := deliver(t, startedModel(t))
			m = finishStream(t, m)
			if n := strings.Count(m.View(), finalAnswer); n != 1 {
				t.Fatalf("the answer is drawn %d times:\n%s", n, m.View())
			}
		})
	}
}

func TestAnswerIsShownWhenOnlyTheEventCarriesIt(t *testing.T) {
	m := startedModel(t)
	m, _ = update(t, m, completed(finalAnswer))
	m, _ = update(t, m, taskDoneMsg{Task: &task.Task{Status: task.StatusCompleted}})
	m = finishStream(t, m)
	if n := strings.Count(m.View(), finalAnswer); n != 1 {
		t.Fatalf("the answer is drawn %d times:\n%s", n, m.View())
	}
}

func TestAFailureIsNotEchoedAsAResult(t *testing.T) {
	m := startedModel(t)
	m, _ = update(t, m, eventMsg{E: event.New(&event.TaskFailedData{Error: "gateway refused"})})
	m, _ = update(t, m, taskDoneMsg{Task: &task.Task{Status: task.StatusFailed, Error: "gateway refused"}})
	m = finishStream(t, m)
	view := m.View()
	if n := strings.Count(view, "gateway refused"); n != 1 {
		t.Fatalf("the error is drawn %d times:\n%s", n, view)
	}
	if strings.Contains(view, "[ result ]") {
		t.Fatalf("a failed task is labelled as a result:\n%s", view)
	}
}

func TestAnAnswerSurvivesTheNextTask(t *testing.T) {
	m := startedModel(t)
	m, _ = update(t, m, doneTask(finalAnswer))
	m = finishStream(t, m)
	m, _ = update(t, m, taskStartedMsg{})
	if !strings.Contains(m.View(), finalAnswer) {
		t.Fatalf("the previous answer vanished when the next task started:\n%s", m.View())
	}

	// And one interrupted mid-animation is kept whole, not lost.
	m, _ = update(t, m, doneTask("second answer, cut short by a new task"))
	m, _ = update(t, m, tickMsg{})
	m, _ = update(t, m, taskStartedMsg{})
	if !strings.Contains(m.View(), "second answer, cut short by a new task") {
		t.Fatalf("an answer interrupted mid-animation was lost:\n%s", m.View())
	}
}

func TestTheAnimationNeverSplitsACharacter(t *testing.T) {
	m := startedModel(t)
	m, _ = update(t, m, doneTask("résumé — naïve café ☕ 日本語テキスト"))
	for m.streamFull != "" {
		if !utf8.ValidString(m.stream) {
			t.Fatalf("partial finalAnswer is not valid UTF-8: %q", m.stream)
		}
		m, _ = update(t, m, tickMsg{})
	}
}

func TestThePromptMarkIsDrawnOnce(t *testing.T) {
	for _, focused := range []bool{true, false} {
		m, _ := newTestModel(t)
		m.width, m.height = 100, 30
		m.inputFocused = focused
		if strings.Contains(m.View(), "> >") {
			t.Fatalf("focused=%v: the prompt reads \"> >\":\n%s", focused, m.View())
		}
		if !strings.Contains(m.renderFooter(), "> ") {
			t.Fatalf("focused=%v: no prompt mark at all", focused)
		}
	}
}

func TestNoCostIsShownBeforeOneIsMeasured(t *testing.T) {
	m, _ := newTestModel(t)
	m.width, m.height = 100, 30
	if strings.Contains(m.View(), "$0") {
		t.Fatalf("a cost nobody measured is shown:\n%s", m.View())
	}
	m.metrics.CostUSD = 0.0123
	if !strings.Contains(m.renderFooter(), "$0.012") {
		t.Fatalf("a measured cost is not shown: %s", m.renderFooter())
	}
	if line := modelReplyLine(event.ModelRespondedData{Model: "m", TokensIn: 3, TokensOut: 4}); strings.Contains(line, "$") {
		t.Fatalf("an unreported cost is printed: %s", line)
	}
}

func TestRepliesAreRenderedNotPrintedAsMarkdown(t *testing.T) {
	src := "## Plan\n\nAdd a `--verbose` flag.\n\n- Parse it\n- Test it\n\n```ts\nconst v = true;\n```\n\n**Done.** 1 file changed."
	out := renderMarkdown(src)
	for _, marker := range []string{"##", "**", "`", "- Parse"} {
		if strings.Contains(out, marker) {
			t.Fatalf("%q survives rendering:\n%s", marker, out)
		}
	}
	for _, kept := range []string{"Plan", "--verbose", "• Parse it", "│ const v = true;", "Done. 1 file changed."} {
		if !strings.Contains(out, kept) {
			t.Fatalf("%q is missing:\n%s", kept, out)
		}
	}

	m := startedModel(t)
	m, _ = update(t, m, doneTask(src))
	m = finishStream(t, m)
	if strings.Contains(m.View(), "## Plan") {
		t.Fatalf("the result bubble prints raw markdown:\n%s", m.View())
	}
}
