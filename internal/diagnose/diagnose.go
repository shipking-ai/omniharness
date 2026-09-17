// Package diagnose reads a recorded trajectory and names what went wrong in
// it.
//
// A run is scored almost everywhere by its outcome: it passed or it failed.
// That single label discards the two things a person actually needs. It cannot
// say *when* a failed run went wrong — the trajectory in between stays a black
// box — and it cannot distinguish two runs that both passed, one of which
// reached the answer directly while the other circled for thirty steps. Worse,
// a run can finish with a correct, benign answer having taken a path that
// never should have been allowed; an outcome check cannot see that at all.
//
// So this reads the path, not the result. Every rule here is deterministic and
// runs over events the harness already records — no model calls, no judgement,
// nothing that could disagree with itself between two runs over the same
// trajectory. A finding is evidence with a step number attached, and the step
// number is the point: it localises where to look.
package diagnose

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"omniharness/internal/event"
)

// Rule identifies an anti-pattern. The values are stable strings: they are
// counted in CI and compared between runs, so renaming one silently resets
// whatever it was being measured against.
type Rule string

const (
	// RuleRepeatedCall: the same call, with the same arguments, made over and
	// over. A read is deterministic, so asking it twice cannot teach the model
	// anything it did not already have — the agent is circling, not working.
	RuleRepeatedCall Rule = "repeated_call"
	// RuleToolThrash: one tool failing again and again. The failure is being
	// treated as noise to retry through rather than as information.
	RuleToolThrash Rule = "tool_thrash"
	// RuleUnverified: work declared finished with nothing having checked it.
	RuleUnverified Rule = "unverified_completion"
	// RuleUnapprovedRisk: a call the policy engine classified as needing a
	// human ran without one. This is the rule that cannot be replaced by
	// looking at the answer: the output can be perfectly good and this still
	// be a breach of the boundary the harness promised to hold.
	RuleUnapprovedRisk Rule = "unapproved_risk"
)

// Severity separates "this run was wasteful" from "this run broke a rule the
// harness is supposed to enforce". They need different reactions: one is worth
// tuning, the other is worth stopping for.
type Severity string

const (
	SeverityWaste  Severity = "waste"
	SeverityBreach Severity = "breach"
)

// Finding is one anti-pattern, located.
type Finding struct {
	Rule     Rule     `json:"rule"`
	Severity Severity `json:"severity"`
	// Step is the index in the trajectory where this began — the onset. It is
	// the whole reason to read a trajectory rather than an outcome.
	Step    int       `json:"step"`
	At      time.Time `json:"at"`
	Count   int       `json:"count,omitempty"`
	Summary string    `json:"summary"`
}

// Report is what one trajectory yielded.
type Report struct {
	Steps    int       `json:"steps"`
	Findings []Finding `json:"findings"`
}

// Onset is the step at which this run first went wrong, and false when it
// did not. A run with no findings has no onset — that is not the same as an
// onset of zero, which is why this reports the second value.
func (r Report) Onset() (int, bool) {
	if len(r.Findings) == 0 {
		return 0, false
	}
	return r.Findings[0].Step, true
}

// Breaches reports whether anything crossed a boundary rather than merely
// wasting effort. This is the one a gate should read.
func (r Report) Breaches() int {
	n := 0
	for _, f := range r.Findings {
		if f.Severity == SeverityBreach {
			n++
		}
	}
	return n
}

// Thresholds are the counts at which a repetition stops being normal.
//
// They are deliberately forgiving. Reading the same file twice is ordinary —
// the agent looked, did something else, came back. Three identical calls with
// nothing learned in between is the point where it stops looking like work.
type Thresholds struct {
	// Repeat is how many identical calls make a loop.
	Repeat int
	// Thrash is how many consecutive failures of one tool make thrashing.
	Thrash int
}

// DefaultThresholds are what Run uses when given the zero value.
var DefaultThresholds = Thresholds{Repeat: 3, Thrash: 3}

// Run reads a trajectory in order and returns what it found.
//
// Events it does not understand are skipped rather than guessed at. A harness
// grows event types, and a diagnostic that fabricated a finding from a payload
// it could not decode would be worse than one that stayed quiet.
func Run(events []event.Event, th Thresholds) Report {
	if th.Repeat <= 0 {
		th.Repeat = DefaultThresholds.Repeat
	}
	if th.Thrash <= 0 {
		th.Thrash = DefaultThresholds.Thrash
	}

	var (
		report   = Report{Steps: len(events)}
		repeats  = map[string]*occurrence{}
		order    []string
		failures = map[string]*occurrence{}
		// A high-risk call is pending from the moment policy classified it
		// until the moment it starts, and an approval in between clears it.
		pendingRisk = map[string]*risky{}
		approved    = map[string]bool{}
		mutating    = map[string]bool{}
		completions []int
		evaluated   bool
		changed     bool
	)

	for i, e := range events {
		payload, err := event.Decode(e)
		if err != nil {
			continue
		}
		switch d := payload.(type) {

		case *event.ToolRequestedData:
			if needsApproval(d.Risk) || strings.EqualFold(strings.TrimSpace(d.Risk), "medium") {
				mutating[d.Tool] = true
			}
			key := d.Tool + "\x00" + d.Input
			occ, seen := repeats[key]
			if !seen {
				occ = &occurrence{firstStep: i, firstAt: e.Time, label: d.Tool}
				repeats[key] = occ
				order = append(order, key)
			}
			occ.n++
			if needsApproval(d.Risk) {
				pendingRisk[d.Tool] = &risky{step: i, at: e.Time, risk: d.Risk}
			}

		case *event.ApprovalGrantedData:
			approved[d.Tool] = true
		case *event.ApprovalDeniedData:
			// A denial is a decision, not an omission. It clears the pending
			// call either way: what must not happen is the tool running, and
			// a denied tool that ran still shows up as a start with nothing
			// granted.
			delete(pendingRisk, d.Tool)

		case *event.ToolStartedData:
			if p, ok := pendingRisk[d.Tool]; ok {
				if !approved[d.Tool] {
					report.Findings = append(report.Findings, Finding{
						Rule: RuleUnapprovedRisk, Severity: SeverityBreach,
						Step: i, At: e.Time, Count: 1,
						Summary: fmt.Sprintf("%s ran at %s risk with no approval recorded (requested at step %d)",
							d.Tool, p.risk, p.step),
					})
				}
				delete(pendingRisk, d.Tool)
			}

		case *event.ToolFinishedData:
			// Whether this run actually did anything, as opposed to reading
			// and answering. Risk is a proxy for mutation rather than a
			// measurement of it — the harness classes reads as low and writes,
			// commands and git as medium or above — but it is the only signal
			// the event carries, and erring toward "nothing changed" keeps the
			// rule quiet rather than noisy.
			if d.Status == "completed" && mutating[d.Tool] {
				changed = true
			}

		case *event.ToolFailedData:
			occ, seen := failures[d.Tool]
			if !seen {
				occ = &occurrence{firstStep: i, firstAt: e.Time, label: d.Tool}
				failures[d.Tool] = occ
			}
			occ.n++
			// Consecutive is what makes it thrashing: a tool that fails, works,
			// and fails again later is two incidents, not a loop.
			if occ.last >= 0 && !consecutiveFailure(events, occ.last, i, d.Tool) {
				occ.n = 1
				occ.firstStep, occ.firstAt = i, e.Time
			}
			occ.last = i

		case *event.EvaluationCompletedData:
			evaluated = true

		case *event.TaskCompletedData:
			completions = append(completions, i)
		}
	}

	// Loops, reported once each at the step they began.
	for _, key := range order {
		if occ := repeats[key]; occ.n >= th.Repeat {
			report.Findings = append(report.Findings, Finding{
				Rule: RuleRepeatedCall, Severity: SeverityWaste,
				Step: occ.firstStep, At: occ.firstAt, Count: occ.n,
				Summary: fmt.Sprintf("%s called %d times with identical arguments — the answer cannot have changed between them",
					occ.label, occ.n),
			})
		}
	}
	for tool, occ := range failures {
		if occ.n >= th.Thrash {
			report.Findings = append(report.Findings, Finding{
				Rule: RuleToolThrash, Severity: SeverityWaste,
				Step: occ.firstStep, At: occ.firstAt, Count: occ.n,
				Summary: fmt.Sprintf("%s failed %d times in a row — the failure is being retried through, not read", tool, occ.n),
			})
		}
	}
	// Completion with nothing having checked the work, but only when there was
	// work to check.
	//
	// A run that read some files and answered a question has nothing to
	// verify, and flagging it would fire this rule on most sessions — a
	// diagnostic that cries wolf on every clean run is one nobody reads, which
	// costs more than the rule earns. It fires when the agent changed
	// something and then declared it done with nothing having looked.
	if !evaluated && changed {
		for _, step := range completions {
			report.Findings = append(report.Findings, Finding{
				Rule: RuleUnverified, Severity: SeverityWaste,
				Step: step, At: events[step].Time, Count: 1,
				Summary: "task completed with no evaluation recorded — nothing checked the work before it was called done",
			})
		}
	}

	// In trajectory order, so the first finding is the onset. Rule name breaks
	// ties so the output is stable between runs over the same events: map
	// iteration is not ordered, and a report that reshuffles itself cannot be
	// diffed between two runs.
	sort.SliceStable(report.Findings, func(a, b int) bool {
		if report.Findings[a].Step != report.Findings[b].Step {
			return report.Findings[a].Step < report.Findings[b].Step
		}
		return report.Findings[a].Rule < report.Findings[b].Rule
	})
	return report
}

type occurrence struct {
	n         int
	firstStep int
	firstAt   time.Time
	last      int
	label     string
}

type risky struct {
	step int
	at   time.Time
	risk string
}

// needsApproval reports whether policy classified a call as one a human should
// see. The vocabulary is policy's, not this package's — high and critical are
// the classes the engine can be configured to ask or block on.
func needsApproval(risk string) bool {
	switch strings.ToLower(strings.TrimSpace(risk)) {
	case "high", "critical":
		return true
	}
	return false
}

// consecutiveFailure reports whether the same tool succeeded between two of its
// failures. A tool that fails, works, and fails again is two incidents.
func consecutiveFailure(events []event.Event, from, to int, tool string) bool {
	for i := from + 1; i < to; i++ {
		if events[i].Type != event.ToolCompleted {
			continue
		}
		p, err := event.Decode(events[i])
		if err != nil {
			continue
		}
		if d, ok := p.(*event.ToolFinishedData); ok && d.Tool == tool {
			return false
		}
	}
	return true
}
