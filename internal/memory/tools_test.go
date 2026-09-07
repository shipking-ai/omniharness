package memory

import (
	"testing"

	"omniharness/internal/id"
	"omniharness/internal/session"
)

func toolStore(t *testing.T) *session.Store {
	t.Helper()
	s, err := session.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	if err := s.CreateSession(&session.Session{ID: "s1", Status: "active"}); err != nil {
		t.Fatal(err)
	}
	return s
}

func record(t *testing.T, s *session.Store, tool, status string, ms int64, errMsg string) {
	t.Helper()
	if err := s.RecordToolCall(&session.ToolCall{
		ID: id.New(), SessionID: "s1", Tool: tool, Status: status,
		Risk: "low", DurationMS: ms, Error: errMsg,
	}); err != nil {
		t.Fatal(err)
	}
}

func TestToolStatsAggregatesRecordedCalls(t *testing.T) {
	s := toolStore(t)
	record(t, s, "mcp:blender:render", "completed", 100, "")
	record(t, s, "mcp:blender:render", "completed", 300, "")
	record(t, s, "mcp:blender:render", "failed", 5, "out of memory on a large scene")
	record(t, s, "mcp:blender:render", "denied", 0, "")
	record(t, s, "read_file", "completed", 2, "")

	stats, err := ToolStats(s)
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]ToolStat{}
	for _, st := range stats {
		byName[st.Tool] = st
	}
	r := byName["mcp:blender:render"]
	if r.Calls != 4 || r.Completed != 2 || r.Failed != 1 || r.Denied != 1 {
		t.Fatalf("render = %+v, want 4 calls / 2 ok / 1 failed / 1 denied", r)
	}
	if r.SuccessRate != 0.5 {
		t.Errorf("SuccessRate = %v, want 0.5", r.SuccessRate)
	}
	// Successful calls only: a tool that fails in 5ms must not look faster
	// than one that works in 300.
	if r.AvgDurationMS != 200 {
		t.Errorf("AvgDurationMS = %d, want 200 (the mean of the successes)", r.AvgDurationMS)
	}
	if r.LastError != "out of memory on a large scene" {
		t.Errorf("LastError = %q, want the recorded failure", r.LastError)
	}
	if byName["read_file"].LastError != "" {
		t.Errorf("a tool that never failed has LastError %q", byName["read_file"].LastError)
	}
	// Most-used first, so the busiest tool is not buried.
	if len(stats) != 2 || stats[0].Tool != "mcp:blender:render" {
		t.Errorf("stats are not ordered by use: %+v", stats)
	}
}

func TestToolStatsKeepsTheMostRecentError(t *testing.T) {
	s := toolStore(t)
	record(t, s, "t", "failed", 1, "first failure")
	record(t, s, "t", "failed", 1, "most recent failure")
	stats, err := ToolStats(s)
	if err != nil {
		t.Fatal(err)
	}
	if stats[0].LastError != "most recent failure" {
		t.Errorf("LastError = %q, want the most recent one", stats[0].LastError)
	}
}

func TestToolStatsOnAnEmptyStore(t *testing.T) {
	stats, err := ToolStats(toolStore(t))
	if err != nil {
		t.Fatalf("an empty store errored: %v", err)
	}
	if len(stats) != 0 {
		t.Errorf("an empty store produced %d stats", len(stats))
	}
}

// One failure out of one call is noise, not a track record. Reporting it would
// train the reader to ignore the warning entirely.
func TestUnreliableNeedsEnoughCallsToJudge(t *testing.T) {
	stats := []ToolStat{
		{Tool: "once", Calls: 1, Completed: 0, SuccessRate: 0},
		{Tool: "flaky", Calls: 10, Completed: 3, SuccessRate: 0.3},
		{Tool: "solid", Calls: 10, Completed: 10, SuccessRate: 1},
		{Tool: "worse", Calls: 10, Completed: 1, SuccessRate: 0.1},
	}
	got := Unreliable(stats, 3, 0.6)
	if len(got) != 2 {
		t.Fatalf("Unreliable = %+v, want only the two with a real record", got)
	}
	// Worst first: the reader should see the biggest problem at the top.
	if got[0].Tool != "worse" || got[1].Tool != "flaky" {
		t.Errorf("order = %s, %s; want worse before flaky", got[0].Tool, got[1].Tool)
	}
	if len(Unreliable(stats, 3, 0)) != 0 {
		t.Error("a zero threshold flagged something")
	}
}

func TestToolStatSummaryIsReadable(t *testing.T) {
	st := ToolStat{Tool: "t", Calls: 4, Completed: 2, Failed: 1, Denied: 1, SuccessRate: 0.5, AvgDurationMS: 200}
	got := st.Summary()
	for _, want := range []string{"4 call", "50% ok", "1 failed", "1 denied", "200ms"} {
		if !contains(got, want) {
			t.Errorf("Summary() = %q, missing %q", got, want)
		}
	}
	clean := ToolStat{Tool: "t", Calls: 3, Completed: 3, SuccessRate: 1}
	if s := clean.Summary(); contains(s, "failed") || contains(s, "denied") {
		t.Errorf("a clean record reads as %q; it should not mention failures", s)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
