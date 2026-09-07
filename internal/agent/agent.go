// Package agent implements the agent runtime: capability-driven roles, a
// lifecycle state machine, and the execution loop that composes context,
// calls models through OmniRoute, executes policy-gated tools, observes
// results and decides whether to continue.
package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"omniharness/internal/budget"
	composer "omniharness/internal/context"
	"omniharness/internal/event"
	"omniharness/internal/gateway"
	"omniharness/internal/id"
	"omniharness/internal/model"
	"omniharness/internal/policy"
	"omniharness/internal/session"
	"omniharness/internal/task"
	"omniharness/internal/tools"
)

// Role identifies a capability-driven agent role. Roles are capabilities, not
// personalities: the same runtime drives any role.
type Role string

const (
	RoleArchitect       Role = "architect"
	RoleImplementer     Role = "implementer"
	RoleResearcher      Role = "researcher"
	RoleDebugger        Role = "debugger"
	RoleReviewer        Role = "reviewer"
	RoleTester          Role = "tester"
	RoleSecurityAuditor Role = "security-auditor"
	RoleOptimizer       Role = "optimizer"
	RoleSynthesizer     Role = "synthesizer"
	// Creative roles. They are split by function, not by medium: a
	// "FilmAgent" or "MusicAgent" would bake the medium into core, which is
	// the same mistake as baking in an application. What medium a run works
	// in comes from the capabilities its tools provide.
	RoleCreativeDirector Role = "creative-director"
	RoleAssetProducer    Role = "asset-producer"
)

// AllRoles lists every role.
func AllRoles() []Role {
	return []Role{RoleArchitect, RoleImplementer, RoleResearcher, RoleDebugger, RoleReviewer,
		RoleTester, RoleSecurityAuditor, RoleOptimizer, RoleSynthesizer,
		RoleCreativeDirector, RoleAssetProducer}
}

// RoleConfig declares a role's system prompt, model intent and tool policy.
type RoleConfig struct {
	Role        Role
	Prompt      string
	ModelIntent model.Intent
	// ToolAllow names specific tools the role may call. It can only ever
	// name tools this build was compiled knowing about, which is why it is
	// not the whole story — see Capabilities.
	ToolAllow []string
	// Capabilities names what the role is allowed to *do*. A tool the role
	// has never heard of becomes available the moment it declares a matching
	// capability, which is how external providers (MCP servers, and whatever
	// comes after them) reach an agent at all: their tool names are generated
	// at runtime, so no ToolAllow list can contain them.
	Capabilities []tools.Capability
	// Both lists empty means "every registered tool", unchanged from before
	// capabilities existed.
}

// AllowsTool reports whether the role may call a tool, by name or by any
// capability the tool declares. Policy still evaluates the call afterwards;
// this only decides what the role is offered and permitted to reach for.
func (rc RoleConfig) AllowsTool(spec tools.Spec) bool {
	if len(rc.ToolAllow) == 0 && len(rc.Capabilities) == 0 {
		return true
	}
	for _, name := range rc.ToolAllow {
		if name == spec.Name {
			return true
		}
	}
	for _, want := range rc.Capabilities {
		for _, have := range spec.Capabilities {
			if have == want {
				return true
			}
		}
	}
	return false
}

// DefaultRoles returns the built-in role definitions.
func DefaultRoles() map[Role]RoleConfig {
	return map[Role]RoleConfig{
		RoleArchitect: {
			Role:         RoleArchitect,
			Prompt:       "You are the architect. Produce precise designs, plans and decomposition. Be concrete: name files, functions and interfaces. Prefer reading before writing.",
			ModelIntent:  model.Intent{Capabilities: []string{model.CapReasoning, model.CapCoding}},
			ToolAllow:    []string{"read_file", "list_dir", "find_files", "search", "git", "remember", "request_replan"},
			Capabilities: caps(tools.CapReadFiles, tools.CapSearchCode, tools.CapVersionControl, tools.CapManageMemory, tools.CapPlanControl),
		},
		RoleImplementer: {
			Role:         RoleImplementer,
			Prompt:       "You are the implementer. Make minimal, correct changes. Prefer editing existing files. Run the provided tools to inspect before you modify. Keep changes focused on the task.",
			ModelIntent:  model.Intent{Capabilities: []string{model.CapCoding, model.CapFast}},
			ToolAllow:    []string{"read_file", "write_file", "edit_file", "list_dir", "find_files", "search", "shell", "git", "remember", "request_replan"},
			Capabilities: caps(tools.CapReadFiles, tools.CapWriteFiles, tools.CapSearchCode, tools.CapExecuteCode, tools.CapVersionControl, tools.CapManageMemory, tools.CapPlanControl, tools.CapExternalTool),
		},
		RoleResearcher: {
			Role:         RoleResearcher,
			Prompt:       "You are the researcher. Gather evidence and sources. Report findings with citations and note uncertainty explicitly. Do not fabricate sources.",
			ModelIntent:  model.Intent{Capabilities: []string{model.CapResearch, model.CapReasoning}},
			ToolAllow:    []string{"read_file", "list_dir", "find_files", "search", "shell", "git", "remember", "request_replan"},
			Capabilities: caps(tools.CapReadFiles, tools.CapSearchCode, tools.CapExecuteCode, tools.CapVersionControl, tools.CapManageMemory, tools.CapPlanControl, tools.CapExternalTool),
		},
		RoleDebugger: {
			Role:         RoleDebugger,
			Prompt:       "You are the debugger. Reproduce the failure first, then isolate root cause with the smallest possible experiment. Report the root cause and the fix.",
			ModelIntent:  model.Intent{Capabilities: []string{model.CapReasoning, model.CapCoding}},
			ToolAllow:    []string{"read_file", "search", "shell", "git", "remember", "request_replan"},
			Capabilities: caps(tools.CapReadFiles, tools.CapSearchCode, tools.CapExecuteCode, tools.CapVersionControl, tools.CapManageMemory, tools.CapPlanControl, tools.CapExternalTool),
		},
		RoleReviewer: {
			Role:         RoleReviewer,
			Prompt:       "You are the reviewer. Check correctness, safety, and adherence to the task. Identify concrete defects with file/line references. Be skeptical; do not rubber-stamp.",
			ModelIntent:  model.Intent{Capabilities: []string{model.CapReview, model.CapReasoning}},
			ToolAllow:    []string{"read_file", "list_dir", "find_files", "search", "shell", "git", "remember", "request_replan"},
			Capabilities: caps(tools.CapReadFiles, tools.CapSearchCode, tools.CapExecuteCode, tools.CapVersionControl, tools.CapManageMemory, tools.CapPlanControl),
		},
		RoleTester: {
			Role:         RoleTester,
			Prompt:       "You are the tester. Write and run tests that prove the behavior described in the task. Report pass/fail per test.",
			ModelIntent:  model.Intent{Capabilities: []string{model.CapCoding, model.CapFast}},
			ToolAllow:    []string{"read_file", "write_file", "edit_file", "search", "shell", "git", "remember", "request_replan"},
			Capabilities: caps(tools.CapReadFiles, tools.CapWriteFiles, tools.CapSearchCode, tools.CapExecuteCode, tools.CapVersionControl, tools.CapManageMemory, tools.CapPlanControl, tools.CapExternalTool),
		},
		RoleSecurityAuditor: {
			Role:         RoleSecurityAuditor,
			Prompt:       "You are the security auditor. Look for injection, secrets, unsafe file/shell operations, and privilege issues. Report severity and concrete fixes.",
			ModelIntent:  model.Intent{Capabilities: []string{model.CapReasoning, model.CapReview}},
			ToolAllow:    []string{"read_file", "search", "git", "remember", "request_replan"},
			Capabilities: caps(tools.CapReadFiles, tools.CapSearchCode, tools.CapVersionControl, tools.CapManageMemory, tools.CapPlanControl),
		},
		RoleOptimizer: {
			Role:         RoleOptimizer,
			Prompt:       "You are the optimizer. Improve performance without changing observable behavior. Measure before and after.",
			ModelIntent:  model.Intent{Capabilities: []string{model.CapCoding, model.CapReasoning}},
			ToolAllow:    []string{"read_file", "edit_file", "search", "shell", "git", "remember", "request_replan"},
			Capabilities: caps(tools.CapReadFiles, tools.CapWriteFiles, tools.CapSearchCode, tools.CapExecuteCode, tools.CapVersionControl, tools.CapManageMemory, tools.CapPlanControl, tools.CapExternalTool),
		},
		RoleCreativeDirector: {
			Role: RoleCreativeDirector,
			Prompt: "You are the creative director. Establish what the piece has to achieve before anything is made, in concrete terms someone else could act on: subject, framing, mood, motion, duration. " +
				"When work comes back, look at it and judge it against that brief — say specifically what is wrong and what to change, or say it is good enough and stop. " +
				"You do not make assets yourself. Do not accept a result you have not actually inspected.",
			ModelIntent:  model.Intent{Capabilities: []string{model.CapVision, model.CapReasoning}},
			ToolAllow:    []string{"read_file", "list_dir", "find_files", "search", "remember", "request_replan"},
			Capabilities: caps(tools.CapReadFiles, tools.CapSearchCode, tools.CapManageMemory, tools.CapPlanControl, tools.CapExternalTool),
		},
		RoleAssetProducer: {
			Role: RoleAssetProducer,
			Prompt: "You are the asset producer. Build what the brief asks for using the tools you have, and inspect the result before reporting it done. " +
				"Work in small steps and check after each one: make a change, look at what it produced, then decide the next change. " +
				"State plainly what you could not achieve with the tools available rather than describing an asset you did not make.",
			ModelIntent:  model.Intent{Capabilities: []string{model.CapReasoning, model.CapVision}},
			ToolAllow:    []string{"read_file", "write_file", "list_dir", "find_files", "search", "shell", "remember", "request_replan"},
			Capabilities: caps(tools.CapReadFiles, tools.CapWriteFiles, tools.CapSearchCode, tools.CapExecuteCode, tools.CapManageMemory, tools.CapPlanControl, tools.CapExternalTool),
		},
		RoleSynthesizer: {
			Role:         RoleSynthesizer,
			Prompt:       "You are the synthesizer. Combine the collected results into one coherent deliverable. Integrate, reconcile conflicts, and produce the final answer.",
			ModelIntent:  model.Intent{Capabilities: []string{model.CapReasoning, model.CapCoding}},
			ToolAllow:    []string{"read_file", "search", "remember", "request_replan"},
			Capabilities: caps(tools.CapReadFiles, tools.CapSearchCode, tools.CapManageMemory, tools.CapPlanControl),
		},
	}
}

func caps(c ...tools.Capability) []tools.Capability { return c }

// Lifecycle is the agent state machine.
type Lifecycle string

const (
	LifecycleCreated   Lifecycle = "created"
	LifecycleReady     Lifecycle = "ready"
	LifecycleThinking  Lifecycle = "thinking"
	LifecycleActing    Lifecycle = "acting"
	LifecycleObserving Lifecycle = "observing"
	LifecyclePaused    Lifecycle = "paused"
	LifecycleCompleted Lifecycle = "completed"
	LifecycleFailed    Lifecycle = "failed"
	LifecycleCancelled Lifecycle = "cancelled"
)

// Deps are the shared runtime dependencies of every agent.
type Deps struct {
	Bus      *event.Bus
	Store    *session.Store
	Gateway  *gateway.Client
	ModelSel *model.Selector
	Tools    *tools.Registry
	Policy   *policy.Engine
	Composer *composer.Composer
	Roles    map[Role]RoleConfig
	// VisionModels are the provider/model refs that accept image input. Not
	// discoverable through OmniRoute's catalog, so it is configuration; an
	// empty set means no image is ever attached.
	VisionModels  []string
	Workspace     string
	MaxIterations int // tool-call loop iterations per agent (0 = 100)
	// ProjectInstructions are durable notes recalled from project memory
	// (see memory.ProjectMemories) — conventions, gotchas, decisions an
	// earlier task remembered about this workspace. Composed into every
	// model call's system prompt; nil means nothing has been remembered yet.
	ProjectInstructions []string
	// Budget bounds the task's total consumption. It is shared by every agent
	// working on the task, because the limits are task-wide: "total tokens
	// across all agents" is not a per-agent allowance. Nil means unlimited.
	Budget *budget.Tracker
	// OnApprovalRequest is invoked when a tool needs human approval. When nil,
	// policy-engine approvals run through its own approver.
	OnApprovalRequest func(a *Agent, r policy.Request, reason string)
}

// Agent is a single runnable agent.
type Agent struct {
	ID          string
	SessionID   string
	TaskID      string
	Role        Role
	Model       string // resolved provider/model
	ModelReason string // why this model was chosen
	Status      task.Status
	Lifecycle   Lifecycle
	Action      string // human-readable current action

	Transcript []gateway.Message
	TokensIn   int64
	TokensOut  int64
	CostUSD    float64
	Latency    time.Duration
	ToolCalls  int

	Spec    task.Spec
	Profile task.Profile
	Summary string // running condensation summary
	// Artifacts are paths produced by artifact-marking tools.
	Artifacts []string
	// pendingImages are images produced by tools during the current
	// iteration, waiting to be attached to the next message.
	pendingImages []tools.Image
	// visionCallModel, when set, routes exactly the next model call to that
	// model so it can look at an attached image. Cleared when consumed.
	visionCallModel string
	// replanReason is set when a replan-marking tool call (request_replan)
	// runs. Read via ReplanReason(); empty means nothing was requested.
	replanReason string
	// repeats guards against the model spinning on one identical tool call;
	// see stall.go. Reset at the start of every Run.
	repeats repeatTracker

	deps   Deps
	mu     sync.Mutex
	cancel context.CancelFunc
	// paused + resume implement pause/resume without closed-channel traps:
	// resume is closed exactly once when a paused agent is resumed.
	paused bool
	resume chan struct{}
	ctx    context.Context
}

// New creates an agent in the Created lifecycle state.
func New(deps Deps, sessionID, taskID string, role Role, modelRef string, spec task.Spec, profile task.Profile) *Agent {
	return &Agent{
		ID:        id.New(),
		SessionID: sessionID,
		TaskID:    taskID,
		Role:      role,
		Model:     modelRef,
		Status:    task.StatusPending,
		Lifecycle: LifecycleCreated,
		Spec:      spec,
		Profile:   profile,
		deps:      deps,
	}
}

// Deps exposes the agent's dependencies (used by the orchestrator).
func (a *Agent) Deps() Deps { return a.deps }

// ResolveModel picks the concrete provider/model and records the reason for
// the choice. An explicitly provided ref (e.g. from a repair plan) wins;
// otherwise the role's model intent is resolved through the selector, which
// consults performance memory when available.
func (a *Agent) ResolveModel() error {
	if a.Model != "" {
		a.ModelReason = "explicit model reference"
		return nil
	}
	roleCfg, ok := a.deps.Roles[a.Role]
	if !ok {
		return fmt.Errorf("unknown role %q", a.Role)
	}
	m, reason, err := a.deps.ModelSel.ResolveExplain(roleCfg.ModelIntent)
	if err != nil {
		return err
	}
	a.Model = m
	a.ModelReason = reason
	return nil
}

// overBudget reports the exceeded dimension, announcing it once so the CLI and
// TUI can show why a run stopped. Returns "" when there is no budget or the
// task is still inside it.
func (a *Agent) overBudget() string {
	if a.deps.Budget == nil {
		return ""
	}
	reason := a.deps.Budget.Exceeded()
	if reason == "" {
		return ""
	}
	a.publish(&event.BudgetExceededData{Dimension: reason, TaskID: a.TaskID})
	return reason
}

func (a *Agent) publish(p event.Payload) {
	e := event.New(p)
	e.SessionID = a.SessionID
	e.TaskID = a.TaskID
	e.AgentID = a.ID
	a.deps.Bus.Publish(e)
}

func (a *Agent) setLifecycle(l Lifecycle, status task.Status, msg string) {
	// Tokens/cost/latency are written concurrently by callModel; read them
	// under the lock to avoid a data race.
	a.mu.Lock()
	a.Lifecycle = l
	a.Status = status
	a.Action = msg
	tokens := a.TokensIn + a.TokensOut
	cost := a.CostUSD
	latency := a.Latency
	a.mu.Unlock()
	a.publish(&event.AgentStateData{
		Role: string(a.Role), Status: status, Model: a.Model, Action: msg,
		Tokens: tokens, CostUSD: cost, Latency: latency,
	})
}

// Pause suspends the agent at its next checkpoint.
func (a *Agent) Pause() {
	a.mu.Lock()
	if !a.paused {
		a.paused = true
		a.resume = make(chan struct{})
	}
	a.mu.Unlock()
	a.setLifecycle(LifecyclePaused, task.StatusPaused, "paused")
}

// Resume continues a paused agent.
func (a *Agent) Resume() {
	a.mu.Lock()
	if a.paused {
		a.paused = false
		close(a.resume)
	}
	a.mu.Unlock()
	a.setLifecycle(LifecycleThinking, task.StatusRunning, "resumed")
}

// Cancel requests graceful termination.
func (a *Agent) Cancel() {
	a.mu.Lock()
	if a.cancel != nil {
		a.cancel()
	}
	a.mu.Unlock()
	a.setLifecycle(LifecycleCancelled, task.StatusCancelled, "cancelled")
}

// Persist writes the agent's durable state (transcript included) to the store.
func (a *Agent) Persist() error {
	a.mu.Lock()
	transcript, err := json.Marshal(a.Transcript)
	status := string(a.Status)
	model := a.Model
	role := string(a.Role)
	a.mu.Unlock()
	if err != nil {
		return err
	}
	return a.deps.Store.UpsertAgent(&session.AgentRecord{
		ID: a.ID, SessionID: a.SessionID, TaskID: a.TaskID, Role: role,
		Model: model, Status: status, Transcript: transcript,
	})
}

// TranscriptJSON returns the persisted JSON form of the transcript.
func (a *Agent) TranscriptJSON() []byte {
	b, _ := json.Marshal(a.Transcript)
	return b
}

// SetTranscript restores a transcript (used when resuming).
func (a *Agent) SetTranscript(messages []gateway.Message) {
	a.Transcript = messages
}

// Run executes the agent loop until completion, cancellation or failure.
func (a *Agent) Run(ctx context.Context) error {
	if err := a.ResolveModel(); err != nil {
		a.setLifecycle(LifecycleFailed, task.StatusFailed, err.Error())
		return err
	}
	if a.deps.MaxIterations <= 0 {
		a.deps.MaxIterations = 100
	}

	runCtx, cancel := context.WithCancel(ctx)
	a.mu.Lock()
	a.ctx = runCtx
	a.cancel = cancel
	a.mu.Unlock()
	defer cancel()

	a.setLifecycle(LifecycleReady, task.StatusRunning, "ready")
	a.publish(&event.AgentCreatedData{Role: string(a.Role), Model: a.Model, TaskID: a.TaskID, SessionID: a.SessionID})
	if err := a.Persist(); err != nil {
		return fmt.Errorf("persist agent: %w", err)
	}
	a.setLifecycle(LifecycleThinking, task.StatusRunning, "thinking")

	roleCfg := a.deps.Roles[a.Role]
	toolSpecs := a.toolSpecs(roleCfg)
	a.repeats = repeatTracker{}

	for iter := 0; iter < a.deps.MaxIterations; iter++ {
		// Pause checkpoint: block until resumed or cancelled.
		a.mu.Lock()
		paused := a.paused
		resume := a.resume
		a.mu.Unlock()
		if paused {
			select {
			case <-runCtx.Done():
				a.setLifecycle(LifecycleCancelled, task.StatusCancelled, "cancelled")
				return context.Canceled
			case <-resume:
			}
		}
		select {
		case <-runCtx.Done():
			a.setLifecycle(LifecycleCancelled, task.StatusCancelled, "cancelled")
			return context.Canceled
		default:
		}

		// Stop before spending anything more. Checked at the top of each
		// iteration so the ceiling bounds what is spent, rather than being
		// noticed after the fact.
		if reason := a.overBudget(); reason != "" {
			a.setLifecycle(LifecycleFailed, task.StatusFailed, reason)
			return fmt.Errorf("%s", reason)
		}

		// Checkpoint the transcript each iteration for resumability.
		if err := a.Persist(); err != nil {
			return fmt.Errorf("persist agent: %w", err)
		}
		a.publish(&event.AgentTranscriptData{Messages: len(a.Transcript)})

		resp, err := a.callModel(runCtx, toolSpecs, roleCfg)
		if err != nil {
			if runCtx.Err() != nil {
				a.setLifecycle(LifecycleCancelled, task.StatusCancelled, "cancelled")
				return context.Canceled
			}
			a.setLifecycle(LifecycleFailed, task.StatusFailed, err.Error())
			return err
		}
		if resp == nil {
			continue
		}
		// Check again now the call has been paid for. Checking only before the
		// next iteration would let a single-turn agent blow any ceiling and
		// still report success, because it never comes round again.
		if reason := a.overBudget(); reason != "" {
			a.setLifecycle(LifecycleFailed, task.StatusFailed, reason)
			return fmt.Errorf("%s", reason)
		}

		msg := resp.Choices[0].Message
		if msg.Content != "" {
			a.Summary = composer.Summarize([]composer.Message{{Role: "assistant", Content: msg.Content}}, 1500)
		}
		a.setLifecycle(LifecycleThinking, task.StatusRunning, "thinking")

		if len(msg.ToolCalls) == 0 {
			// Final answer.
			if msg.Content != "" {
				a.Transcript = append(a.Transcript, msg)
			}
			a.setLifecycle(LifecycleCompleted, task.StatusCompleted, "completed")
			if err := a.Persist(); err != nil {
				return err
			}
			return nil
		}

		// The assistant message carrying the tool_calls MUST precede the tool
		// results in the transcript: OpenAI wire format rejects tool messages
		// without a matching assistant tool_calls message, and the model needs
		// the history to continue coherently.
		a.Transcript = append(a.Transcript, msg)

		// Execute tool calls.
		a.setLifecycle(LifecycleActing, task.StatusRunning, "acting")
		for _, tc := range msg.ToolCalls {
			if reason := a.overBudget(); reason != "" {
				a.setLifecycle(LifecycleFailed, task.StatusFailed, reason)
				return fmt.Errorf("%s", reason)
			}
			a.ToolCalls++
			if a.deps.Budget != nil {
				a.deps.Budget.AddToolCall()
			}
			nudge, stalled := a.repeats.observe(tc)
			if stalled {
				reason := a.repeats.reason(tc.Function.Name)
				a.setLifecycle(LifecycleFailed, task.StatusFailed, reason)
				return fmt.Errorf("%s", reason)
			}
			obs := nudge
			if obs == "" {
				obs = a.executeToolCall(runCtx, tc, roleCfg)
				stale, exhausted := a.repeats.record(tc, obs)
				if exhausted {
					reason := a.repeats.staleReason()
					a.setLifecycle(LifecycleFailed, task.StatusFailed, reason)
					return fmt.Errorf("%s", reason)
				}
				if stale != "" {
					obs = stale
				}
			}
			if runCtx.Err() != nil {
				a.setLifecycle(LifecycleCancelled, task.StatusCancelled, "cancelled")
				return context.Canceled
			}
			a.Transcript = append(a.Transcript, gateway.Message{
				Role: "tool", ToolCallID: tc.ID, Name: tc.Function.Name, Content: obs,
			})
			a.publish(&event.ObservationCreatedData{
				Tool: tc.Function.Name, AgentID: a.ID, Summary: truncate(obs, 200), OutputLen: len(obs),
			})
		}

		// An image observation cannot ride in a tool result: the wire
		// format gives a tool message a plain string and nowhere to put one.
		// It becomes a following user message instead — attached when the
		// model can accept images, described when it cannot, because a model
		// that silently receives nothing is worse off than one told plainly
		// that it cannot look.
		if m := a.flushPendingImages(); m != nil {
			a.Transcript = append(a.Transcript, *m)
		}
		a.setLifecycle(LifecycleObserving, task.StatusRunning, "observing")
	}

	return fmt.Errorf("agent exceeded %d iterations", a.deps.MaxIterations)
}

// callModel composes context and performs one model call.
func (a *Agent) callModel(ctx context.Context, toolSpecs []gateway.ToolSpec, roleCfg RoleConfig) (*gateway.ChatResponse, error) {
	// One call may run on a different model than the rest — an image
	// observation is routed to a model that can actually see it. The agent's
	// own Model is unchanged: this is a detour for a single turn, not a
	// switch, and everything recorded below names the model that did the work.
	modelRef, reason := a.Model, a.ModelReason
	a.mu.Lock()
	if a.visionCallModel != "" {
		modelRef = a.visionCallModel
		reason = "routed to a vision-capable model to look at tool image output"
		a.visionCallModel = ""
	}
	a.mu.Unlock()

	in := composer.Input{
		Spec:                a.Spec,
		Profile:             a.Profile,
		SystemPrompt:        roleCfg.Prompt,
		ProjectInstructions: a.deps.ProjectInstructions,
		History:             toContextMessages(a.Transcript),
		Summary:             a.Summary,
	}
	out, err := a.deps.Composer.Compose(in)
	if err != nil {
		return nil, err
	}
	if out.Condensed {
		a.publish(&event.ContextData{Reason: "history condensed at token limit"})
	}

	a.setLifecycle(LifecycleThinking, task.StatusRunning, "thinking")
	a.publish(&event.ModelRequestedData{Model: modelRef, TaskID: a.TaskID, AgentID: a.ID, Stream: false, Reason: reason})

	start := time.Now()
	req := gateway.ChatRequest{
		Model:    modelRef,
		Messages: toGatewayMessages(out.Messages),
		Tools:    toolSpecs,
	}
	resp, err := a.deps.Gateway.Chat(ctx, req)
	latency := time.Since(start)
	if err != nil {
		a.publish(&event.ModelFailedData{Model: modelRef, TaskID: a.TaskID, AgentID: a.ID, Error: err.Error()})
		_ = a.recordModelCall(req, nil, latency, err)
		return nil, err
	}

	usage := resp.Usage
	cost := model.EstimateCost(modelRef, usage.PromptTokens, usage.CompletionTokens)
	a.mu.Lock()
	a.TokensIn += usage.PromptTokens
	a.TokensOut += usage.CompletionTokens
	a.CostUSD += cost
	a.Latency += latency
	a.mu.Unlock()
	if a.deps.Budget != nil {
		a.deps.Budget.AddTokens(usage.PromptTokens+usage.CompletionTokens, cost)
	}
	a.publish(&event.ModelRespondedData{
		// modelRef, not a.Model: a routed vision turn runs on a different
		// model, and the reply must be attributed to the one that produced it.
		Model: modelRef, TaskID: a.TaskID, AgentID: a.ID,
		TokensIn: usage.PromptTokens, TokensOut: usage.CompletionTokens, CostUSD: cost, Latency: latency,
	})
	_ = a.recordModelCall(req, resp, latency, nil)
	return resp, nil
}

func (a *Agent) recordModelCall(req gateway.ChatRequest, resp *gateway.ChatResponse, latency time.Duration, err error) error {
	status := "ok"
	errMsg := ""
	if err != nil {
		status = "failed"
		errMsg = err.Error()
	}
	var in, out int64
	if resp != nil {
		in, out = resp.Usage.PromptTokens, resp.Usage.CompletionTokens
	}
	// The request carries the model that actually ran, which is not always
	// a.Model: an image observation is routed to a vision-capable model for
	// one turn. Recording a.Model credited that work to the wrong model and
	// put its cost on the wrong row.
	provider, _ := gateway.SplitModel(req.Model)
	return a.deps.Store.RecordModelCall(&session.ModelCall{
		SessionID: a.SessionID, TaskID: a.TaskID, AgentID: a.ID,
		Provider: provider, Model: req.Model, TokensIn: in, TokensOut: out,
		CostUSD: model.EstimateCost(a.Model, in, out), LatencyMS: latency.Milliseconds(),
		Status: status, Error: errMsg,
	})
}

// executeToolCall runs one tool call through policy and returns the
// observation string fed back to the model.
func (a *Agent) executeToolCall(ctx context.Context, tc gateway.ToolCall, roleCfg RoleConfig) string {
	name := tc.Function.Name
	args, err := tools.DecodeArgs(tc.Function.Arguments)
	if err != nil {
		return "tool arguments error: " + err.Error()
	}

	tool, ok := a.deps.Tools.Get(name)
	if !ok {
		return fmt.Sprintf("error: unknown tool %q", name)
	}
	spec := tool.Spec()

	// Role reach: by name, or by any capability the tool declares. This
	// mirrors toolSpecs exactly — a model can only be offered what it may
	// call — but is re-checked here because a model can name a tool it was
	// never offered.
	if !roleCfg.AllowsTool(spec) {
		return fmt.Sprintf("error: tool %q is not allowed for role %s", name, a.Role)
	}

	a.publish(&event.ToolRequestedData{
		Tool: name, Input: truncate(tc.Function.Arguments, 200), Risk: string(spec.Risk), AgentID: a.ID,
	})

	// Validate before policy, not after: a malformed call is the model's
	// mistake to fix, and putting it in front of a human approver asks them
	// to sanction an action that was never coherent. It also matters most for
	// external tools, whose arguments otherwise reach a foreign process
	// unchecked.
	if err := tools.ValidateInput(spec, args); err != nil {
		a.publish(&event.ToolFinishedData{Tool: name, AgentID: a.ID, Status: "failed", Error: err.Error()})
		_ = a.recordToolCall(name, "failed", spec.Risk, 0, err.Error())
		return toolErrorMessage(name, err, "")
	}

	req := policy.Request{Tool: name, Input: args, Risk: spec.Risk, AgentID: a.ID, Effects: spec.Effects}
	decision, err := a.deps.Policy.EvaluateAndExecute(ctx, req)
	if err != nil {
		a.publish(&event.ToolFinishedData{Tool: name, AgentID: a.ID, Status: "denied", Error: err.Error()})
		_ = a.recordToolCall(name, "denied", spec.Risk, 0, err.Error())
		return fmt.Sprintf("tool %s was denied by policy: %v", name, err)
	}
	if decision != policy.Allow {
		a.publish(&event.ToolFinishedData{Tool: name, AgentID: a.ID, Status: "denied"})
		_ = a.recordToolCall(name, "denied", spec.Risk, 0, "denied by policy")
		return fmt.Sprintf("tool %s was denied by policy", name)
	}

	a.publish(&event.ToolStartedData{Tool: name, AgentID: a.ID})
	a.setLifecycle(LifecycleActing, task.StatusRunning, "tool: "+name)
	start := time.Now()
	result, runErr := tool.Run(ctx, args)
	duration := time.Since(start)

	if result.Artifact {
		a.mu.Lock()
		// Paths the tool chose itself (an external tool handing back an
		// image), then the path the caller named in the input.
		a.Artifacts = append(a.Artifacts, result.Artifacts...)
		if p, ok := args["path"].(string); ok {
			a.Artifacts = append(a.Artifacts, p)
		}
		a.pendingImages = append(a.pendingImages, result.Images...)
		a.mu.Unlock()
	}
	if result.Replan {
		a.mu.Lock()
		if a.replanReason == "" {
			a.replanReason = result.Output
		}
		a.mu.Unlock()
	}

	if runErr != nil {
		a.publish(&event.ToolFinishedData{Tool: name, AgentID: a.ID, Status: "failed", Duration: duration, Error: runErr.Error()})
		_ = a.recordToolCall(name, "failed", spec.Risk, duration.Milliseconds(), runErr.Error())
		return toolErrorMessage(name, runErr, truncate(result.Output, 2000))
	}
	a.publish(&event.ToolFinishedData{Tool: name, AgentID: a.ID, Status: "completed", Duration: duration, OutputLen: len(result.Output)})
	_ = a.recordToolCall(name, "completed", spec.Risk, duration.Milliseconds(), "")
	return result.Output
}

func (a *Agent) recordToolCall(name, status string, risk tools.Risk, durationMS int64, errMsg string) error {
	return a.deps.Store.RecordToolCall(&session.ToolCall{
		SessionID: a.SessionID, TaskID: a.TaskID, AgentID: a.ID,
		Tool: name, Status: status, Risk: string(risk), DurationMS: durationMS, Error: errMsg,
	})
}

// toolSpecs builds the gateway tool list for the agent.
// toolSpecs is the set of tools offered to the model for this role. It reads
// the registry's full specs rather than the model-facing projection, because
// the reach decision needs capabilities and the projection drops them.
func (a *Agent) toolSpecs(roleCfg RoleConfig) []gateway.ToolSpec {
	var out []gateway.ToolSpec
	for _, spec := range a.deps.Tools.List() {
		if !roleCfg.AllowsTool(spec) {
			continue
		}
		out = append(out, gateway.ToolSpec{
			Type: "function",
		})
		// set fields via index to keep type literal simple
		out[len(out)-1].Function.Name = spec.Name
		out[len(out)-1].Function.Description = spec.Description
		out[len(out)-1].Function.Parameters = spec.Parameters
	}
	return out
}

// Usage returns token/cost/latency snapshots.
func (a *Agent) Usage() (in, out, calls int64, cost float64, latency time.Duration) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.TokensIn, a.TokensOut, int64(a.ToolCalls), a.CostUSD, a.Latency
}

// ArtifactPaths returns the artifact paths produced by the agent.
func (a *Agent) ArtifactPaths() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.Artifacts...)
}

// ReplanReason returns why the agent asked for the task to be restructured
// (see the request_replan tool), or "" if it never did.
func (a *Agent) ReplanReason() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.replanReason
}

// LastOutput returns the final assistant message content, if any.
func (a *Agent) LastOutput() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	for i := len(a.Transcript) - 1; i >= 0; i-- {
		if a.Transcript[i].Role == "assistant" && a.Transcript[i].Content != "" {
			return a.Transcript[i].Content
		}
	}
	return ""
}

func toContextMessages(msgs []gateway.Message) []composer.Message {
	out := make([]composer.Message, 0, len(msgs))
	for _, m := range msgs {
		out = append(out, composer.Message{Role: m.Role, Content: m.Content, ToolCallID: m.ToolCallID, Name: m.Name, Images: m.Images, ToolCalls: m.ToolCalls})
	}
	return out
}

func toGatewayMessages(msgs []composer.Message) []gateway.Message {
	out := make([]gateway.Message, 0, len(msgs))
	for _, m := range msgs {
		out = append(out, gateway.Message{Role: m.Role, Content: m.Content, ToolCallID: m.ToolCallID, Name: m.Name, Images: m.Images, ToolCalls: m.ToolCalls})
	}
	return out
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// toolErrorMessage is what the model reads after a failed call. The kind
// carries the one thing the raw message usually does not: whether calling
// again could possibly work. Without it a model retries a tool whose provider
// has gone away until it runs out of iterations.
func toolErrorMessage(name string, err error, output string) string {
	kind := tools.KindOf(err)
	msg := fmt.Sprintf("tool %s failed (%s): %v\n%s", name, kind, err, kind.Guidance())
	if output != "" {
		msg += "\n" + output
	}
	return msg
}

// CanSeeImages reports whether this agent's model accepts image input.
func (a *Agent) CanSeeImages() bool {
	for _, m := range a.deps.VisionModels {
		if m == a.Model {
			return true
		}
	}
	return false
}

// visionModel returns a declared vision-capable model, preferring the one the
// agent is already running on so an observation does not change models for no
// reason. Empty means none is configured and no image can be shown to anyone.
func (a *Agent) visionModel() string {
	if a.CanSeeImages() {
		return a.Model
	}
	if len(a.deps.VisionModels) == 0 {
		return ""
	}
	return a.deps.VisionModels[0]
}

// maxAttachedImageBytes caps one attached image. A data URL is base64, so an
// attachment costs about a third more than the file, and an unbounded render
// would blow the context window in a single message.
const maxAttachedImageBytes = 4 << 20

// maxAttachedImages caps how many go into one message.
const maxAttachedImages = 4

// flushPendingImages turns the images produced this iteration into the user
// message that carries them, and clears the queue. Returns nil when there is
// nothing to say.
func (a *Agent) flushPendingImages() *gateway.Message {
	a.mu.Lock()
	pending := a.pendingImages
	a.pendingImages = nil
	a.mu.Unlock()
	if len(pending) == 0 {
		return nil
	}

	viewer := a.visionModel()
	if viewer == "" {
		var b strings.Builder
		b.WriteString("The tool produced image output, which this model cannot view. ")
		b.WriteString("Work from the file(s) directly or from other evidence:")
		for _, img := range pending {
			b.WriteString("\n- " + img.Path)
		}
		a.publish(&event.LogMessageData{Message: fmt.Sprintf(
			"%d image(s) not shown: model %s is not declared vision-capable (set [models] vision)",
			len(pending), a.Model)})
		return &gateway.Message{Role: "user", Content: b.String()}
	}

	var refs []gateway.ImageRef
	var notes []string
	for _, img := range pending {
		if len(refs) >= maxAttachedImages {
			notes = append(notes, img.Path+" (not attached: too many images in one step)")
			continue
		}
		data, err := os.ReadFile(img.Path)
		if err != nil {
			notes = append(notes, img.Path+" (could not be read: "+err.Error()+")")
			continue
		}
		if len(data) > maxAttachedImageBytes {
			notes = append(notes, fmt.Sprintf("%s (not attached: %d bytes exceeds the %d byte limit)",
				img.Path, len(data), maxAttachedImageBytes))
			continue
		}
		refs = append(refs, gateway.ImageRef{MimeType: img.MimeType, Data: data, Source: img.Path})
	}

	var b strings.Builder
	if len(refs) > 0 {
		b.WriteString("Here is the image output from the tool call above. Look at it and continue.")
	} else {
		b.WriteString("The tool produced image output that could not be attached.")
	}
	for _, n := range notes {
		b.WriteString("\n- " + n)
	}
	if len(refs) > 0 {
		// Route the next call to the viewer only when it is not the model
		// already in use; a needless switch would misreport which model ran.
		if viewer != a.Model {
			a.mu.Lock()
			a.visionCallModel = viewer
			a.mu.Unlock()
		}
		a.publish(&event.ObservationCreatedData{AgentID: a.ID,
			Summary: fmt.Sprintf("attached %d image(s) for %s to look at", len(refs), viewer)})
	}
	return &gateway.Message{Role: "user", Content: b.String(), Images: refs}
}
