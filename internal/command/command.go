// Package command adapts a local command-line program into a capability-
// bearing tool.
//
// MCP is one way to reach an external program; a great many useful ones —
// ffmpeg, ImageMagick, yt-dlp, HandBrakeCLI — will never ship an MCP server
// and do not need to. They already have a stable interface. This package is
// the second adapter behind tools.Tool, and its existence is the real test of
// that interface: if reaching a program required changes inside the tool
// registry or the agent, the abstraction would be wrong.
//
// Nothing here knows what ffmpeg is. A command is entirely described by
// configuration: what to run, what arguments it takes, what capabilities it
// provides and what it does to the world.
package command

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"omniharness/internal/envguard"
	"omniharness/internal/tools"
)

// Provider labels command-backed tools in tools.Spec.Provider.
const Provider = "command"

// Spec describes one command-line program exposed as a tool.
type Spec struct {
	// Name is the tool name the model sees.
	Name string
	// Description tells the model what it is for. Without one the model has
	// only a name to go on, so an empty description is rejected.
	Description string
	// Command is the executable. Looked up on PATH unless absolute.
	Command string
	// Args are fixed arguments placed before the caller's.
	Args []string
	// ArgsParam names the tool argument holding the caller-supplied argument
	// list (an array of strings). Empty means the tool takes no arguments at
	// all, which is valid for a fixed command.
	ArgsParam string
	// Capabilities and Effects are the operator's declarations, exactly as
	// for an MCP server.
	Capabilities []tools.Capability
	Effects      []tools.Effect
	// Risk defaults to high: an arbitrary local program can do anything, and
	// the safe default for something the harness cannot inspect is to make
	// policy decide.
	Risk tools.Risk
	// Timeout bounds one run. Zero means DefaultTimeout.
	Timeout time.Duration
	// WorkDir is the directory the command runs in. Empty means the
	// workspace the runtime configured.
	WorkDir string
	// MaxOutput caps captured output. Zero means DefaultMaxOutput.
	MaxOutput int
}

// Defaults for an under-specified command.
const (
	DefaultTimeout   = 2 * time.Minute
	DefaultMaxOutput = 64 << 10
)

// Tool is a Spec bound to a workspace, satisfying tools.Tool.
type Tool struct {
	spec      Spec
	workspace string
}

// New validates a Spec and binds it to a workspace.
func New(s Spec, workspace string) (*Tool, error) {
	if strings.TrimSpace(s.Name) == "" {
		return nil, errors.New("command tool has no name")
	}
	if strings.TrimSpace(s.Command) == "" {
		return nil, fmt.Errorf("command tool %q has no command", s.Name)
	}
	if strings.TrimSpace(s.Description) == "" {
		return nil, fmt.Errorf("command tool %q has no description; a model given only a name cannot use it well", s.Name)
	}
	for _, c := range s.Capabilities {
		if err := tools.ValidateCapability(c); err != nil {
			return nil, fmt.Errorf("command tool %q: %w", s.Name, err)
		}
	}
	for _, e := range s.Effects {
		if err := tools.ValidateEffect(e); err != nil {
			return nil, fmt.Errorf("command tool %q: %w", s.Name, err)
		}
	}
	if s.Risk == "" {
		s.Risk = tools.RiskHigh
	}
	if s.Timeout <= 0 {
		s.Timeout = DefaultTimeout
	}
	if s.MaxOutput <= 0 {
		s.MaxOutput = DefaultMaxOutput
	}
	return &Tool{spec: s, workspace: workspace}, nil
}

// Available reports whether the program can actually be found. A configured
// command that is not installed should be visible as absent rather than
// registered and failing on first use.
func (t *Tool) Available() error {
	if filepath.IsAbs(t.spec.Command) {
		return nil
	}
	if _, err := exec.LookPath(t.spec.Command); err != nil {
		return fmt.Errorf("command %q is not on PATH", t.spec.Command)
	}
	return nil
}

// Spec implements tools.Tool.
func (t *Tool) Spec() tools.Spec {
	params := map[string]any{
		"type":                 "object",
		"properties":           map[string]any{},
		"additionalProperties": false,
	}
	if t.spec.ArgsParam != "" {
		params["properties"] = map[string]any{
			t.spec.ArgsParam: map[string]any{
				"type":        "array",
				"items":       map[string]any{"type": "string"},
				"description": "arguments passed to " + t.spec.Command,
			},
		}
		params["required"] = []string{t.spec.ArgsParam}
	}
	caps := append([]tools.Capability(nil), t.spec.Capabilities...)
	sort.Slice(caps, func(i, j int) bool { return caps[i] < caps[j] })
	return tools.Spec{
		Name:         t.spec.Name,
		Description:  t.spec.Description,
		Parameters:   params,
		Risk:         t.spec.Risk,
		Capabilities: caps,
		Effects:      append([]tools.Effect(nil), t.spec.Effects...),
		Provider:     Provider,
		ExecutesCode: true,
	}
}

// Run executes the command. Arguments are passed as a list and never through
// a shell: a single string would let an argument that merely contains a
// semicolon become a second command.
func (t *Tool) Run(ctx context.Context, input map[string]any) (tools.Result, error) {
	args := append([]string(nil), t.spec.Args...)
	if t.spec.ArgsParam != "" {
		extra, err := stringList(input[t.spec.ArgsParam])
		if err != nil {
			return tools.Result{}, &tools.Error{
				Kind: tools.ErrInvalidInput, Tool: t.spec.Name,
				Message: fmt.Sprintf("%s: %v", t.spec.ArgsParam, err),
			}
		}
		args = append(args, extra...)
	}

	dir := t.spec.WorkDir
	if dir == "" {
		dir = t.workspace
	}

	runCtx, cancel := context.WithTimeout(ctx, t.spec.Timeout)
	defer cancel()

	cmd := exec.CommandContext(runCtx, t.spec.Command, args...)
	cmd.Dir = dir
	// Same rule as an MCP server process: inherit the environment so the
	// program can find its own libraries, minus anything holding a credential.
	cmd.Env = envguard.Filter()
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out

	err := cmd.Run()
	text := truncate(out.String(), t.spec.MaxOutput)

	if runCtx.Err() == context.DeadlineExceeded {
		return tools.Result{Output: text}, &tools.Error{
			Kind: tools.ErrTimeout, Tool: t.spec.Name,
			Message: fmt.Sprintf("did not finish within %s", t.spec.Timeout),
		}
	}
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			// The program ran and failed: ordinary, and its own output is the
			// most useful thing to hand back.
			return tools.Result{Output: text}, &tools.Error{
				Kind: tools.ErrFailed, Tool: t.spec.Name,
				Message: fmt.Sprintf("exited %d", exitErr.ExitCode()),
			}
		}
		// Could not start at all — missing binary, bad directory.
		return tools.Result{Output: text}, &tools.Error{
			Kind: tools.ErrUnavailable, Tool: t.spec.Name, Message: err.Error(),
		}
	}
	return tools.Result{Output: text}, nil
}

func stringList(v any) ([]string, error) {
	if v == nil {
		return nil, nil
	}
	raw, ok := v.([]any)
	if !ok {
		if list, ok := v.([]string); ok {
			return list, nil
		}
		return nil, errors.New("must be an array of strings")
	}
	out := make([]string, 0, len(raw))
	for i, item := range raw {
		s, ok := item.(string)
		if !ok {
			return nil, fmt.Errorf("element %d is not a string", i)
		}
		out = append(out, s)
	}
	return out, nil
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "\n…[output truncated]"
}
