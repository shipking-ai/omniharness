package cli

import (
	"encoding/json"
	"fmt"
	"text/tabwriter"

	"github.com/spf13/cobra"

	"omniharness/internal/diagnose"
)

// newDiagnoseCmd reads a recorded run and says what went wrong in it.
//
// `log` already prints every event, which is the raw material and too much of
// it: a real session is thousands of lines and the three that matter are not
// marked. This answers the question a person actually has after a bad run —
// where did it start going wrong — and the question a CI job has: did this run
// cross a line.
func newDiagnoseCmd() *cobra.Command {
	var (
		asJSON bool
		strict bool
		repeat int
		thrash int
	)
	cmd := &cobra.Command{
		Use:   "diagnose <session>",
		Short: "Find anti-patterns in a recorded run",
		Long: `Read a session's trajectory and report anti-patterns: identical calls
repeated with nothing learned between them, one tool failing over and over,
work declared finished with nothing having checked it, and high-risk calls
that ran without an approval.

Every rule is deterministic and reads events the harness already recorded.
No model is called, so the same session always produces the same report.

Exit status is 0 unless --strict is given, in which case a breach exits 1 —
which is what a CI job wants.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			rt, err := newRuntime(cmd.Context())
			if err != nil {
				return err
			}
			defer rt.Close()

			evs, err := rt.SessionEvents(args[0], 100000)
			if err != nil {
				return fmt.Errorf("load events: %w", err)
			}
			if len(evs) == 0 {
				return fmt.Errorf("no events recorded for session %s", args[0])
			}

			report := diagnose.Run(evs, diagnose.Thresholds{Repeat: repeat, Thrash: thrash})

			if asJSON {
				enc := json.NewEncoder(cmd.OutOrStdout())
				enc.SetIndent("", "  ")
				if err := enc.Encode(report); err != nil {
					return err
				}
			} else {
				printDiagnosis(cmd, report)
			}
			if strict && report.Breaches() > 0 {
				// A breach is the one class worth failing a pipeline over: the
				// output can be perfectly good and the run still have crossed
				// a boundary the harness promised to hold.
				return fmt.Errorf("%d boundary breach(es) in session %s", report.Breaches(), args[0])
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "emit the report as JSON")
	cmd.Flags().BoolVar(&strict, "strict", false, "exit non-zero when a boundary was crossed")
	cmd.Flags().IntVar(&repeat, "repeat-threshold", 0, "identical calls before it counts as a loop (default 3)")
	cmd.Flags().IntVar(&thrash, "thrash-threshold", 0, "consecutive failures of one tool before it counts as thrashing (default 3)")
	return cmd
}

func printDiagnosis(cmd *cobra.Command, r diagnose.Report) {
	out := cmd.OutOrStdout()
	if len(r.Findings) == 0 {
		fmt.Fprintf(out, "%d steps, nothing flagged\n", r.Steps)
		return
	}
	// The onset leads, because "where did this start going wrong" is the
	// question a person opens this to answer.
	if onset, ok := r.Onset(); ok {
		fmt.Fprintf(out, "%d steps · first went wrong at step %d · %d finding(s), %d breach(es)\n\n",
			r.Steps, onset, len(r.Findings), r.Breaches())
	}
	w := tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "STEP\tSEVERITY\tRULE\tWHAT HAPPENED")
	for _, f := range r.Findings {
		fmt.Fprintf(w, "%d\t%s\t%s\t%s\n", f.Step, f.Severity, f.Rule, f.Summary)
	}
	_ = w.Flush()
}
