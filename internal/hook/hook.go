// Package hook is where guarantees the model cannot be trusted to enforce get
// enforced.
//
// A system prompt asking an agent never to do something is a request. It is
// usually honoured, which is the problem: usually is not a guarantee, and the
// cases where it is not honoured are exactly the ones that matter — a model
// under pressure from a long trajectory, or one reading content that was
// written to change its mind. A hook is ordinary code on the path the action
// has to travel, so it holds whether or not the model cooperates.
//
// # Hooks can stop things, never start them
//
// There is no "allow" here, and that is deliberate rather than an omission.
// If a hook could sanction an action, a hook would be a way around the policy
// engine and the approval gate — and the first thing anyone would write is the
// one that approves everything. So a hook's only power is to refuse, policy
// still runs regardless of what hooks say, and a call survives only if both
// let it through. Adding a permissive verdict later would not be an extension
// of this design, it would be the end of it.
//
// # A guard that fails is not a guard
//
// A hook that errors at a guard point denies the call. The alternative — carry
// on and log it — means a broken guard silently stops guarding while the
// interface still claims the rule is enforced, which is worse than a visible
// halt. Hooks that only observe cannot deny anything, so an error there is
// recorded and the run continues.
package hook

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"
)

// Point is a place in the run where hooks are consulted.
type Point string

const (
	// BeforeTool runs before a tool call reaches policy. A denial here stops
	// the call and, because it comes first, spares a human an approval prompt
	// for something that was never going to be allowed.
	BeforeTool Point = "before_tool"
	// BeforeModel runs before a model request is sent.
	BeforeModel Point = "before_model"
	// AfterTool runs once a tool has finished. Observation only: the work has
	// already happened, so there is nothing left to refuse.
	AfterTool Point = "after_tool"
)

// guarding reports whether a denial at this point can still prevent anything.
// It is what decides whether a hook error fails closed.
func (p Point) guarding() bool { return p == BeforeTool || p == BeforeModel }

// Call is what a hook is shown.
type Call struct {
	Point Point
	// Tool is the tool being called, at the tool points.
	Tool string
	// Args are the decoded arguments. A guard needs the real values — a
	// truncated copy cannot tell a path inside the workspace from one outside
	// it — so this is not the clipped form that goes to the event log.
	Args map[string]any
	// Risk is the class policy assigned, where one applies.
	Risk string
	// Model is the model a request is bound for, at BeforeModel.
	Model string
	// AgentID and TaskID locate the call in the run.
	AgentID string
	TaskID  string
	// Status and Error describe a finished tool call, at AfterTool.
	Status string
	Error  string
}

// Hook is a rule. Deny with a reason, or return nil to stand aside.
//
// A hook must not block: it is on the path of every call it is registered for,
// and the deadline on the context is the only thing standing between a slow
// hook and a stalled run.
type Hook interface {
	// Name identifies the hook in denials and logs. It reaches the model as
	// part of the refusal, so it should read as a rule rather than an
	// identifier — "workspace-confinement", not "hook3".
	Name() string
	// Points are where this hook is consulted.
	Points() []Point
	// Check returns a non-nil error to deny. The error text is shown to the
	// model and to the user, so it should say what was refused and why.
	Check(ctx context.Context, c Call) error
}

// Denial is why a call was refused, and by which rule.
type Denial struct {
	Hook   string
	Reason string
}

func (d *Denial) Error() string { return fmt.Sprintf("%s: %s", d.Hook, d.Reason) }

// Registry holds the hooks for a run.
//
// The zero value is usable and consults nothing, so a runtime with no hooks
// configured pays for none of this.
type Registry struct {
	mu      sync.RWMutex
	byPoint map[Point][]Hook
	// Timeout bounds one hook. Zero means DefaultTimeout.
	Timeout time.Duration
}

// DefaultTimeout is how long one hook may take. A hook is ordinary local code
// on the path of every call, so this is short on purpose: a rule that needs
// longer than this is doing work that does not belong on this path.
const DefaultTimeout = 2 * time.Second

// NewRegistry returns an empty registry.
func NewRegistry() *Registry { return &Registry{byPoint: map[Point][]Hook{}} }

// Add registers a hook at each of its points.
func (r *Registry) Add(h Hook) error {
	if h == nil {
		return errors.New("nil hook")
	}
	if h.Name() == "" {
		return errors.New("hook has no name")
	}
	points := h.Points()
	if len(points) == 0 {
		return fmt.Errorf("hook %q registers at no point", h.Name())
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.byPoint == nil {
		r.byPoint = map[Point][]Hook{}
	}
	for _, p := range points {
		r.byPoint[p] = append(r.byPoint[p], h)
	}
	return nil
}

// Names lists the registered hooks at a point, in registration order.
func (r *Registry) Names(p Point) []string {
	if r == nil {
		return nil
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]string, 0, len(r.byPoint[p]))
	for _, h := range r.byPoint[p] {
		out = append(out, h.Name())
	}
	return out
}

// Run consults every hook at a point and returns the first denial.
//
// Every hook runs even after one has denied, because a hook may be doing
// something besides deciding — recording, counting — and skipping the rest
// would make a run's behaviour depend on the order rules happen to be
// registered in. The denial reported is the first in registration order, so
// the answer does not move about between runs.
func (r *Registry) Run(ctx context.Context, c Call) error {
	if r == nil {
		return nil
	}
	r.mu.RLock()
	hooks := append([]Hook(nil), r.byPoint[c.Point]...)
	timeout := r.Timeout
	r.mu.RUnlock()
	if len(hooks) == 0 {
		return nil
	}
	if timeout <= 0 {
		timeout = DefaultTimeout
	}

	type result struct {
		index int
		err   error
	}
	var denials []result
	for i, h := range hooks {
		err := runOne(ctx, h, c, timeout)
		if err == nil {
			continue
		}
		// At an observation point there is nothing left to prevent, so a
		// failing hook is noted by its caller rather than turned into a
		// refusal of work that already happened.
		if !c.Point.guarding() {
			continue
		}
		denials = append(denials, result{index: i, err: &Denial{Hook: h.Name(), Reason: err.Error()}})
	}
	if len(denials) == 0 {
		return nil
	}
	sort.SliceStable(denials, func(a, b int) bool { return denials[a].index < denials[b].index })
	return denials[0].err
}

// runOne bounds a single hook and converts a panic into a denial.
//
// A hook that panics has failed, and at a guard point a failed guard denies:
// letting the call through because the rule crashed would mean the interface
// claims a rule is enforced while nothing is enforcing it.
func runOne(ctx context.Context, h Hook, c Call, timeout time.Duration) (err error) {
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("hook panicked: %v", p)
		}
	}()
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	done := make(chan error, 1)
	go func() {
		defer func() {
			if p := recover(); p != nil {
				done <- fmt.Errorf("hook panicked: %v", p)
			}
		}()
		done <- h.Check(ctx, c)
	}()
	select {
	case e := <-done:
		return e
	case <-ctx.Done():
		// The hook is left running; it cannot be killed. What matters is that
		// the run is not held by it.
		return fmt.Errorf("hook did not answer within %s", timeout)
	}
}

// Func adapts a function into a Hook.
type Func struct {
	HookName string
	At       []Point
	Fn       func(ctx context.Context, c Call) error
}

func (f Func) Name() string    { return f.HookName }
func (f Func) Points() []Point { return f.At }
func (f Func) Check(ctx context.Context, c Call) error {
	if f.Fn == nil {
		return nil
	}
	return f.Fn(ctx, c)
}
