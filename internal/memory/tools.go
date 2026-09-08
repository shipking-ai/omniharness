package memory

import (
	"fmt"
	"sort"
	"strings"

	"omniharness/internal/session"
)

// ToolStat is the recorded track record of one tool, across every session in
// this store. It answers the question the brief for this work put plainly:
// which tools are reliable, and which ones commonly fail.
type ToolStat struct {
	Tool string `json:"tool"`
	// Calls counts every attempt, including ones policy denied.
	Calls int `json:"calls"`
	// Completed, Failed and Denied partition Calls.
	Completed int `json:"completed"`
	Failed    int `json:"failed"`
	Denied    int `json:"denied"`
	// SuccessRate is Completed over Calls, 0 when never called.
	SuccessRate float64 `json:"successRate"`
	// AvgDurationMS averages successful calls only. A tool that fails fast
	// would otherwise look quicker than one that works.
	AvgDurationMS int64 `json:"avgDurationMs"`
	// LastError is the most recent failure message, empty if it has never
	// failed. This is what turns "fails sometimes" into something actionable.
	LastError string `json:"lastError,omitempty"`
}

// ToolStats aggregates recorded tool calls, most-used first. Nothing here
// needs a schema change: the runtime has always recorded every call's tool,
// status, duration and error — the rows were simply never read back.
func ToolStats(s *session.Store) ([]ToolStat, error) {
	rows, err := s.DB().Query(`
		SELECT tool,
		       COUNT(*),
		       COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0),
		       COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0),
		       COALESCE(SUM(CASE WHEN status = 'denied' THEN 1 ELSE 0 END), 0),
		       COALESCE(AVG(CASE WHEN status = 'completed' THEN duration_ms END), 0)
		FROM tool_calls
		WHERE tool <> ''
		GROUP BY tool
		ORDER BY 2 DESC, tool ASC`)
	if err != nil {
		return nil, fmt.Errorf("aggregate tool stats: %w", err)
	}
	defer rows.Close()

	var out []ToolStat
	for rows.Next() {
		var st ToolStat
		var avg float64
		if err := rows.Scan(&st.Tool, &st.Calls, &st.Completed, &st.Failed, &st.Denied, &avg); err != nil {
			return nil, err
		}
		st.AvgDurationMS = int64(avg)
		if st.Calls > 0 {
			st.SuccessRate = float64(st.Completed) / float64(st.Calls)
		}
		out = append(out, st)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// The most recent failure per tool, fetched separately: doing it in the
	// aggregate above would need a correlated subquery per row for something
	// only failing tools have.
	errRows, err := s.DB().Query(`
		SELECT tool, error FROM tool_calls
		WHERE status = 'failed' AND error <> ''
		ORDER BY created_at ASC`)
	if err != nil {
		return nil, fmt.Errorf("aggregate tool errors: %w", err)
	}
	defer errRows.Close()
	latest := map[string]string{}
	for errRows.Next() {
		var tool, msg string
		if err := errRows.Scan(&tool, &msg); err != nil {
			return nil, err
		}
		latest[tool] = msg // ascending order, so the last write wins
	}
	if err := errRows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		out[i].LastError = latest[out[i].Tool]
	}
	return out, nil
}

// Unreliable returns the tools whose track record is bad enough to be worth
// saying out loud: at least minCalls attempts and a success rate below
// threshold. Below minCalls a tool has no track record, only noise — one
// failure out of one call is not evidence of anything.
func Unreliable(stats []ToolStat, minCalls int, threshold float64) []ToolStat {
	if minCalls < 1 {
		minCalls = 1
	}
	var out []ToolStat
	for _, st := range stats {
		if st.Calls >= minCalls && st.SuccessRate < threshold {
			out = append(out, st)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].SuccessRate != out[j].SuccessRate {
			return out[i].SuccessRate < out[j].SuccessRate
		}
		return out[i].Tool < out[j].Tool
	})
	return out
}

// Summary renders a tool's record as one line for an operator.
func (st ToolStat) Summary() string {
	var b strings.Builder
	fmt.Fprintf(&b, "%d call(s), %.0f%% ok", st.Calls, st.SuccessRate*100)
	if st.Failed > 0 {
		fmt.Fprintf(&b, ", %d failed", st.Failed)
	}
	if st.Denied > 0 {
		fmt.Fprintf(&b, ", %d denied by policy", st.Denied)
	}
	if st.AvgDurationMS > 0 {
		fmt.Fprintf(&b, ", ~%dms", st.AvgDurationMS)
	}
	return b.String()
}
