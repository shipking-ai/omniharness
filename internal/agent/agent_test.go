package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	composer "omniharness/internal/context"
	"omniharness/internal/event"
	"omniharness/internal/gateway"
	"omniharness/internal/hook"
	"omniharness/internal/model"
	"omniharness/internal/policy"
	"omniharness/internal/session"
	"omniharness/internal/task"
	"omniharness/internal/testutil"
	"omniharness/internal/tools"
)

func testDeps(t *testing.T, fake *testutil.FakeOmniRoute, workspace string) Deps {
	t.Helper()
	store, err := session.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })

	reg := tools.NewRegistry()
	if err := tools.NewNative(workspace).Register(reg); err != nil {
		t.Fatal(err)
	}
	pol := policy.NewEngine(policy.Config{
		RiskAction: map[string]string{
			"low": "allow", "medium": "allow", "high": "ask", "critical": "block",
		},
		ShellAllowed:            true,
		GitPushRequiresApproval: true,
	}, nil)

	// A simple approver that grants everything (used only when policy asks).
	pol.SetApprover(policy.ApproverFunc(func(context.Context, policy.Request, string) (bool, error) {
		return true, nil
	}))

	return Deps{
		Bus:           event.NewBus(),
		Store:         store,
		Gateway:       fake.Client(),
		ModelSel:      model.NewSelector("fake/m1", nil),
		Tools:         reg,
		Policy:        pol,
		Composer:      composer.NewComposer(composer.Limits{CondenseAt: 1 << 18}),
		Roles:         DefaultRoles(),
		Workspace:     workspace,
		MaxIterations: 10,
	}
}

func runAgent(t *testing.T, deps Deps, spec task.Spec, role Role) (*Agent, error) {
	t.Helper()
	profile := (&task.Analyzer{}).Analyze(spec)
	ag := New(deps, "sess1", "task1", role, "", spec, profile)
	err := ag.Run(context.Background())
	return ag, err
}

func TestAgentTranscriptKeepsAssistantToolCallsMessage(t *testing.T) {
	dir := t.TempDir()
	fake := testutil.NewFakeOmniRoute(t,
		testutil.FakeStep{ToolCalls: []gateway.ToolCall{
			testutil.ToolCall("c1", "read_file", `{"path":"a.txt"}`),
		}},
		testutil.FakeStep{Content: "done"},
	)
	deps := testDeps(t, fake, dir)
	ag := New(deps, "sess1", "task1", RoleImplementer, "", task.Spec{Prompt: "do the thing"}, task.Profile{})
	if err := ag.Run(context.Background()); err != nil {
		t.Fatalf("run: %v", err)
	}
	if ag.Status != task.StatusCompleted {
		t.Fatalf("status = %s", ag.Status)
	}
	// Wire protocol invariant: every tool message must be preceded by the
	// assistant message that declared its tool_calls.
	var pendingToolCallIDs []string
	for _, m := range ag.Transcript {
		switch m.Role {
		case "assistant":
			for _, tc := range m.ToolCalls {
				pendingToolCallIDs = append(pendingToolCallIDs, tc.ID)
			}
		case "tool":
			found := -1
			for i, id := range pendingToolCallIDs {
				if id == m.ToolCallID {
					found = i
					break
				}
			}
			if found < 0 {
				t.Fatalf("tool message %q has no preceding assistant tool_calls entry", m.ToolCallID)
			}
			pendingToolCallIDs = append(pendingToolCallIDs[:found], pendingToolCallIDs[found+1:]...)
		}
	}
}

func TestAgentCompletesWithToolLoop(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "greeting.txt"), []byte("hello"), 0o644)
	fake := testutil.NewFakeOmniRoute(t,
		testutil.FakeStep{ToolCalls: []gateway.ToolCall{
			testutil.ToolCall("call_1", "read_file", `{"path":"greeting.txt"}`),
		}},
		testutil.FakeStep{Content: "The file says hello."},
	)
	deps := testDeps(t, fake, dir)
	ag, err := runAgent(t, deps, task.Spec{Prompt: "read greeting.txt and summarize it"}, RoleImplementer)
	if err != nil {
		t.Fatal(err)
	}
	if ag.Status != task.StatusCompleted {
		t.Fatalf("status = %s", ag.Status)
	}
	if !strings.Contains(ag.LastOutput(), "hello") {
		t.Fatalf("output %q", ag.LastOutput())
	}
	// Tool call must have been executed and recorded.
	calls, _ := deps.Store.ToolCalls("sess1")
	if len(calls) != 1 || calls[0].Tool != "read_file" || calls[0].Status != "completed" {
		t.Fatalf("tool calls %+v", calls)
	}
	// Model calls recorded with the resolved model ref.
	mcs, _ := deps.Store.ModelCalls("sess1")
	if len(mcs) != 2 {
		t.Fatalf("model calls = %d", len(mcs))
	}
	if mcs[0].Model != "fake/m1" {
		t.Fatalf("model = %q", mcs[0].Model)
	}
	// Transcript persisted for resumability.
	rec, err := deps.Store.Agent(ag.ID)
	if err != nil {
		t.Fatal(err)
	}
	var transcript []gateway.Message
	_ = json.Unmarshal(rec.Transcript, &transcript)
	if len(transcript) < 2 {
		t.Fatalf("transcript too short: %d", len(transcript))
	}
}

func TestAgentModelErrorFails(t *testing.T) {
	fake := testutil.NewFakeOmniRoute(t)
	fake.FailChat = &gateway.Error{Kind: gateway.KindRateLimit, Status: 429, Message: "slow down"}
	deps := testDeps(t, fake, t.TempDir())
	_, err := runAgent(t, deps, task.Spec{Prompt: "do something"}, RoleImplementer)
	if err == nil {
		t.Fatal("expected model error")
	}
	ge := &gateway.Error{}
	if !strings.Contains(err.Error(), "omniroute") {
		t.Fatalf("error %v", err)
	}
	_ = ge
}

func TestAgentDeniedToolContinues(t *testing.T) {
	dir := t.TempDir()
	fake := testutil.NewFakeOmniRoute(t,
		testutil.FakeStep{ToolCalls: []gateway.ToolCall{
			testutil.ToolCall("c1", "shell", `{"command":"echo blocked > x.txt"}`),
		}},
		testutil.FakeStep{Content: "done"},
	)
	deps := testDeps(t, fake, dir)
	// Deny everything via a blocking approver.
	deps.Policy.SetApprover(policy.ApproverFunc(func(context.Context, policy.Request, string) (bool, error) {
		return false, nil
	}))
	ag, err := runAgent(t, deps, task.Spec{Prompt: "create x.txt via shell"}, RoleImplementer)
	if err != nil {
		t.Fatal(err)
	}
	if ag.Status != task.StatusCompleted {
		t.Fatalf("status = %s", ag.Status)
	}
	if _, err := os.Stat(filepath.Join(dir, "x.txt")); err == nil {
		t.Fatal("file must not exist after denial")
	}
	calls, _ := deps.Store.ToolCalls("sess1")
	if len(calls) != 1 || calls[0].Status != "denied" {
		t.Fatalf("tool calls %+v", calls)
	}
}

func TestAgentCancellation(t *testing.T) {
	dir := t.TempDir()
	fake := testutil.NewFakeOmniRoute(t,
		testutil.FakeStep{Delay: 2 * time.Second},
	)
	deps := testDeps(t, fake, dir)
	ctx, cancel := context.WithCancel(context.Background())
	ag := New(deps, "sess1", "task1", RoleImplementer, "", task.Spec{Prompt: "slow"}, task.Profile{})

	done := make(chan error, 1)
	go func() { done <- ag.Run(ctx) }()
	time.Sleep(150 * time.Millisecond)
	ag.Cancel()
	cancel()
	select {
	case err := <-done:
		if err != context.Canceled && err != nil {
			t.Fatalf("err = %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("agent did not stop")
	}
	if ag.Status != task.StatusCancelled && ag.Status != task.StatusFailed {
		t.Fatalf("status = %s", ag.Status)
	}
}

func TestAgentPauseResume(t *testing.T) {
	dir := t.TempDir()
	// The scripted model always requests a tool call, so the agent keeps
	// looping until cancelled — ideal for exercising pause/resume.
	fake := testutil.NewFakeOmniRoute(t,
		testutil.FakeStep{ToolCalls: []gateway.ToolCall{
			testutil.ToolCall("c1", "read_file", `{"path":"greeting.txt"}`),
		}, Delay: 100 * time.Millisecond},
	)
	deps := testDeps(t, fake, dir)
	deps.MaxIterations = 100
	ag := New(deps, "sess1", "task1", RoleImplementer, "", task.Spec{Prompt: "pause test"}, task.Profile{})

	done := make(chan error, 1)
	go func() { done <- ag.Run(context.Background()) }()

	// Let a couple of iterations happen, then pause.
	time.Sleep(350 * time.Millisecond)
	ag.Pause()
	time.Sleep(150 * time.Millisecond)
	select {
	case <-done:
		t.Fatal("agent must not finish while paused")
	default:
	}
	countWhilePaused := fake.RequestCount()
	time.Sleep(200 * time.Millisecond)
	if fake.RequestCount() != countWhilePaused {
		t.Fatal("agent kept calling the model while paused")
	}

	ag.Resume()
	time.Sleep(250 * time.Millisecond)
	if fake.RequestCount() <= countWhilePaused {
		t.Fatal("agent did not resume making progress")
	}
	ag.Cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("agent did not stop after cancel")
	}
}

func TestAgentToolArgumentsDecoded(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "data.json"), []byte(`{"k":"v"}`), 0o644)
	fake := testutil.NewFakeOmniRoute(t,
		testutil.FakeStep{ToolCalls: []gateway.ToolCall{
			testutil.ToolCall("c1", "read_file", `{"path": "data.json"}`),
		}},
		testutil.FakeStep{Content: "finished"},
	)
	deps := testDeps(t, fake, dir)
	ag, err := runAgent(t, deps, task.Spec{Prompt: "read data.json"}, RoleImplementer)
	if err != nil {
		t.Fatal(err)
	}
	if ag.Status != task.StatusCompleted {
		t.Fatalf("status = %s", ag.Status)
	}
	// The transcript must include the tool observation.
	found := false
	for _, m := range ag.Transcript {
		if m.Role == "tool" && strings.Contains(m.Content, `"k":"v"`) {
			found = true
		}
	}
	if !found {
		t.Fatal("tool observation missing from transcript")
	}
}

// A role's ToolAllow is a hardcoded list, not derived from the tool
// registry — adding a new native tool does nothing for a role until that
// role's list names it explicitly. "remember" was added as a tool without
// updating any role's list, which silently denied every call to it (an
// error observation the model saw, not a task failure) until this was
// caught. Pinned here so a future tool cannot go dark the same way for
// every role at once.
func TestEveryDefaultRoleCanRemember(t *testing.T) {
	for role, cfg := range DefaultRoles() {
		found := false
		for _, name := range cfg.ToolAllow {
			if name == "remember" {
				found = true
			}
		}
		if !found {
			t.Errorf("role %s cannot call \"remember\": %v", role, cfg.ToolAllow)
		}
	}
}

// The same regression class as TestEveryDefaultRoleCanRemember, for the
// other tool that ships without needing a dependency wired up.
func TestEveryDefaultRoleCanRequestReplan(t *testing.T) {
	for role, cfg := range DefaultRoles() {
		found := false
		for _, name := range cfg.ToolAllow {
			if name == "request_replan" {
				found = true
			}
		}
		if !found {
			t.Errorf("role %s cannot call \"request_replan\": %v", role, cfg.ToolAllow)
		}
	}
}

func TestAgentRecordsAReplanRequest(t *testing.T) {
	fake := testutil.NewFakeOmniRoute(t,
		testutil.FakeStep{ToolCalls: []gateway.ToolCall{
			testutil.ToolCall("call_1", "request_replan", `{"reason":"found two unrelated bugs, not one"}`),
		}},
		testutil.FakeStep{Content: "noted"},
	)
	deps := testDeps(t, fake, t.TempDir())
	ag, err := runAgent(t, deps, task.Spec{Prompt: "fix the bug"}, RoleImplementer)
	if err != nil {
		t.Fatal(err)
	}
	if ag.Status != task.StatusCompleted {
		t.Fatalf("status = %s", ag.Status)
	}
	if got := ag.ReplanReason(); !strings.Contains(got, "found two unrelated bugs") {
		t.Fatalf("ReplanReason() = %q, want it to carry the tool call's reason", got)
	}
}

// The first request_replan call wins — a second one in the same run must
// not silently overwrite the reason the orchestrator will act on.
func TestAgentKeepsTheFirstReplanReason(t *testing.T) {
	fake := testutil.NewFakeOmniRoute(t,
		testutil.FakeStep{ToolCalls: []gateway.ToolCall{
			testutil.ToolCall("call_1", "request_replan", `{"reason":"first reason"}`),
		}},
		testutil.FakeStep{ToolCalls: []gateway.ToolCall{
			testutil.ToolCall("call_2", "request_replan", `{"reason":"second reason"}`),
		}},
		testutil.FakeStep{Content: "done"},
	)
	deps := testDeps(t, fake, t.TempDir())
	ag, err := runAgent(t, deps, task.Spec{Prompt: "fix the bug"}, RoleImplementer)
	if err != nil {
		t.Fatal(err)
	}
	if got := ag.ReplanReason(); got != "replan requested: first reason" {
		t.Fatalf("ReplanReason() = %q, want the first request to have won", got)
	}
}

// A normal run — no request_replan call anywhere — must report no reason at
// all, not an empty-but-non-nil signal.
func TestAgentWithNoReplanRequestHasNoReason(t *testing.T) {
	fake := testutil.NewFakeOmniRoute(t, testutil.FakeStep{Content: "done"})
	deps := testDeps(t, fake, t.TempDir())
	ag, err := runAgent(t, deps, task.Spec{Prompt: "fix the bug"}, RoleImplementer)
	if err != nil {
		t.Fatal(err)
	}
	if got := ag.ReplanReason(); got != "" {
		t.Fatalf("ReplanReason() = %q, want empty", got)
	}
}

// --- what the interface is told about context reduction ----------------------

// "Condensed" alone cannot distinguish a run that shed a few stale tool
// payloads from one throwing away whole turns. The second is a run in trouble;
// the first is the system working. A reader who cannot tell them apart tunes
// neither.
func TestContextReasonNamesTheRungAndItsCost(t *testing.T) {
	cases := []struct {
		name string
		out  composer.Output
		want []string
		deny []string
	}{
		{
			name: "elision only",
			out:  composer.Output{Condensed: true, Tier: composer.TierToolResults, Elided: 2},
			want: []string{"elided", "2"},
			deny: []string{"dropped"},
		},
		{
			name: "turns dropped after elision",
			out:  composer.Output{Condensed: true, Tier: composer.TierDropTurns, Elided: 3, Dropped: 7},
			want: []string{"elided", "3", "dropped", "7"},
		},
		{
			name: "turns dropped with nothing to elide",
			out:  composer.Output{Condensed: true, Tier: composer.TierDropTurns, Dropped: 4},
			want: []string{"dropped", "4"},
			deny: []string{"elided"},
		},
		{
			name: "the task itself does not fit",
			out:  composer.Output{Condensed: true, Tier: composer.TierTrimPrompt},
			want: []string{"task alone exceeds"},
			deny: []string{"dropped", "elided"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := contextReason(tc.out)
			for _, want := range tc.want {
				if !strings.Contains(got, want) {
					t.Errorf("reason %q is missing %q", got, want)
				}
			}
			for _, deny := range tc.deny {
				if strings.Contains(got, deny) {
					t.Errorf("reason %q should not mention %q", got, deny)
				}
			}
		})
	}
}

// --- hooks on the tool path ---------------------------------------------------

func writeCall(id, path, content string) gateway.ToolCall {
	c := gateway.ToolCall{ID: id, Type: "function"}
	c.Function.Name = "write_file"
	c.Function.Arguments = `{"path":"` + path + `","content":"` + content + `"}`
	return c
}

// A rule in a system prompt is a request. A hook is on the path the action has
// to travel, so it holds whether or not the model cooperates.
func TestHookRefusesAToolCallTheModelInsistsOn(t *testing.T) {
	dir := t.TempDir()
	fake := testutil.NewFakeOmniRoute(t,
		testutil.FakeStep{ToolCalls: []gateway.ToolCall{writeCall("w1", "secrets.env", "KEY=1")}},
		testutil.FakeStep{Content: "gave up"},
	)
	deps := testDeps(t, fake, dir)
	hooks := hook.NewRegistry()
	if err := hooks.Add(hook.Func{
		HookName: "no-env-files",
		At:       []hook.Point{hook.BeforeTool},
		Fn: func(_ context.Context, c hook.Call) error {
			if p, _ := c.Args["path"].(string); strings.HasSuffix(p, ".env") {
				return fmt.Errorf("writing %s is not allowed in this workspace", p)
			}
			return nil
		},
	}); err != nil {
		t.Fatal(err)
	}
	deps.Hooks = hooks

	ag, err := runAgent(t, deps, task.Spec{Prompt: "write the env file", CWD: dir}, RoleImplementer)
	if err != nil {
		t.Fatalf("the run should continue after a refusal, not fail: %v", err)
	}
	_ = ag

	if _, err := os.Stat(filepath.Join(dir, "secrets.env")); err == nil {
		t.Fatal("the hook refused the write and the file exists anyway")
	}
	// The model is told which rule refused it and why, so it can do something
	// else rather than retry the same call.
	var refusal string
	for _, m := range ag.Transcript {
		if m.Role == "tool" && strings.Contains(m.Content, "refused") {
			refusal = m.Content
		}
	}
	if refusal == "" {
		t.Fatalf("no refusal reached the model:\n%+v", ag.Transcript)
	}
	if !strings.Contains(refusal, "no-env-files") {
		t.Errorf("the refusal should name the rule: %q", refusal)
	}
}

// The property the design rests on, tested where it actually matters: a hook
// that stands aside must not turn into an approval. Policy still runs, and a
// tool policy blocks stays blocked no matter how permissive the hooks are.
func TestPermissiveHookCannotUnblockWhatPolicyBlocks(t *testing.T) {
	dir := t.TempDir()
	fake := testutil.NewFakeOmniRoute(t,
		testutil.FakeStep{ToolCalls: []gateway.ToolCall{writeCall("w1", "a.txt", "x")}},
		testutil.FakeStep{Content: "gave up"},
	)
	deps := testDeps(t, fake, dir)

	// Policy blocks every write.
	blocking := policy.NewEngine(policy.Config{
		RiskAction: map[string]string{
			"low": "allow", "medium": "block", "high": "block", "critical": "block",
		},
		ShellAllowed: true,
	}, nil)
	blocking.SetApprover(policy.ApproverFunc(func(context.Context, policy.Request, string) (bool, error) {
		return true, nil
	}))
	deps.Policy = blocking

	hooks := hook.NewRegistry()
	_ = hooks.Add(hook.Func{
		HookName: "approve-everything",
		At:       []hook.Point{hook.BeforeTool},
		Fn:       func(context.Context, hook.Call) error { return nil },
	})
	deps.Hooks = hooks

	ag, err := runAgent(t, deps, task.Spec{Prompt: "write a file", CWD: dir}, RoleImplementer)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(dir, "a.txt")); statErr == nil {
		t.Fatal("a permissive hook got a policy-blocked write through — hooks must not be able to grant")
	}
	denied := false
	for _, m := range ag.Transcript {
		if m.Role == "tool" && strings.Contains(m.Content, "denied by policy") {
			denied = true
		}
	}
	if !denied {
		t.Fatalf("policy should still have denied the call:\n%+v", ag.Transcript)
	}
}

// With no hooks configured nothing changes, so the feature costs nothing to
// anyone who has not asked for it.
func TestNoHooksLeavesTheToolPathAlone(t *testing.T) {
	dir := t.TempDir()
	fake := testutil.NewFakeOmniRoute(t,
		testutil.FakeStep{ToolCalls: []gateway.ToolCall{writeCall("w1", "a.txt", "x")}},
		testutil.FakeStep{Content: "done"},
	)
	deps := testDeps(t, fake, dir) // Hooks left nil
	if _, err := runAgent(t, deps, task.Spec{Prompt: "write a file", CWD: dir}, RoleImplementer); err != nil {
		t.Fatalf("run: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "a.txt")); err != nil {
		t.Fatalf("the write should have happened normally: %v", err)
	}
}

// Hooks run before policy, and the observable consequence is this: when a rule
// was always going to refuse a call, nobody is asked to approve it.
//
// An approval prompt for something that cannot happen is the exact shape of
// prompt that teaches people to approve without reading, so the ordering is
// not an implementation detail.
func TestHookDenialSparesTheHumanAnApprovalPrompt(t *testing.T) {
	dir := t.TempDir()
	fake := testutil.NewFakeOmniRoute(t,
		testutil.FakeStep{ToolCalls: []gateway.ToolCall{writeCall("w1", "secrets.env", "KEY=1")}},
		testutil.FakeStep{Content: "gave up"},
	)
	deps := testDeps(t, fake, dir)

	// Policy asks a human about every write.
	var asked int32
	asking := policy.NewEngine(policy.Config{
		RiskAction: map[string]string{
			"low": "allow", "medium": "ask", "high": "ask", "critical": "block",
		},
		ShellAllowed: true,
	}, nil)
	asking.SetApprover(policy.ApproverFunc(func(context.Context, policy.Request, string) (bool, error) {
		atomic.AddInt32(&asked, 1)
		return true, nil
	}))
	deps.Policy = asking

	hooks := hook.NewRegistry()
	_ = hooks.Add(hook.Func{
		HookName: "no-env-files",
		At:       []hook.Point{hook.BeforeTool},
		Fn: func(_ context.Context, c hook.Call) error {
			if p, _ := c.Args["path"].(string); strings.HasSuffix(p, ".env") {
				return fmt.Errorf("writing %s is not allowed", p)
			}
			return nil
		},
	})
	deps.Hooks = hooks

	if _, err := runAgent(t, deps, task.Spec{Prompt: "write the env file", CWD: dir}, RoleImplementer); err != nil {
		t.Fatalf("run: %v", err)
	}
	if n := atomic.LoadInt32(&asked); n != 0 {
		t.Fatalf("a human was asked %d time(s) to approve a call a rule had already refused", n)
	}
	if _, err := os.Stat(filepath.Join(dir, "secrets.env")); err == nil {
		t.Fatal("the file was written")
	}
}

// And a call no hook objects to still reaches the approver, so the ordering
// does not quietly skip policy.
func TestCallsHooksAllowStillReachPolicy(t *testing.T) {
	dir := t.TempDir()
	fake := testutil.NewFakeOmniRoute(t,
		testutil.FakeStep{ToolCalls: []gateway.ToolCall{writeCall("w1", "notes.txt", "x")}},
		testutil.FakeStep{Content: "done"},
	)
	deps := testDeps(t, fake, dir)

	var asked int32
	asking := policy.NewEngine(policy.Config{
		RiskAction: map[string]string{
			"low": "allow", "medium": "ask", "high": "ask", "critical": "block",
		},
		ShellAllowed: true,
	}, nil)
	asking.SetApprover(policy.ApproverFunc(func(context.Context, policy.Request, string) (bool, error) {
		atomic.AddInt32(&asked, 1)
		return true, nil
	}))
	deps.Policy = asking

	hooks := hook.NewRegistry()
	_ = hooks.Add(hook.Func{
		HookName: "no-env-files",
		At:       []hook.Point{hook.BeforeTool},
		Fn:       func(context.Context, hook.Call) error { return nil },
	})
	deps.Hooks = hooks

	if _, err := runAgent(t, deps, task.Spec{Prompt: "write notes", CWD: dir}, RoleImplementer); err != nil {
		t.Fatalf("run: %v", err)
	}
	if n := atomic.LoadInt32(&asked); n == 0 {
		t.Fatal("a hook standing aside skipped policy entirely — silence is not approval")
	}
}

// --- how often a person is interrupted ---------------------------------------

// batchCountingApprover records interruptions and how much each one covered.
type batchCountingApprover struct {
	mu      sync.Mutex
	prompts int
	sizes   []int
	deny    map[string]bool
}

func (b *batchCountingApprover) grant(r policy.Request) bool {
	p, _ := r.Input["path"].(string)
	return !b.deny[p]
}

func (b *batchCountingApprover) RequestApproval(_ context.Context, r policy.Request, _ string) (bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.prompts++
	b.sizes = append(b.sizes, 1)
	return b.grant(r), nil
}

func (b *batchCountingApprover) RequestApprovalBatch(_ context.Context, rs []policy.Request, _ []string) ([]bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.prompts++
	b.sizes = append(b.sizes, len(rs))
	out := make([]bool, len(rs))
	for i, r := range rs {
		out[i] = b.grant(r)
	}
	return out, nil
}

// A model turn asking to write four files used to produce four prompts, one
// after another, each identical in shape. Nobody reads the fourth.
func TestOneModelTurnInterruptsAPersonOnce(t *testing.T) {
	dir := t.TempDir()
	calls := []gateway.ToolCall{
		writeCall("w1", "a.txt", "1"), writeCall("w2", "b.txt", "2"),
		writeCall("w3", "c.txt", "3"), writeCall("w4", "d.txt", "4"),
	}
	fake := testutil.NewFakeOmniRoute(t,
		testutil.FakeStep{ToolCalls: calls},
		testutil.FakeStep{Content: "done"},
	)
	deps := testDeps(t, fake, dir)

	ap := &batchCountingApprover{}
	pol := policy.NewEngine(policy.Config{
		RiskAction:   map[string]string{"low": "allow", "medium": "ask", "high": "ask", "critical": "block"},
		ShellAllowed: true,
	}, ap)
	deps.Policy = pol

	if _, err := runAgent(t, deps, task.Spec{Prompt: "write four files", CWD: dir}, RoleImplementer); err != nil {
		t.Fatalf("run: %v", err)
	}

	if ap.prompts != 1 {
		t.Fatalf("a person was interrupted %d times for one turn (sizes %v)", ap.prompts, ap.sizes)
	}
	if ap.sizes[0] != 4 {
		t.Fatalf("the single prompt covered %d of 4 writes", ap.sizes[0])
	}
	for _, name := range []string{"a.txt", "b.txt", "c.txt", "d.txt"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Errorf("%s was approved but not written: %v", name, err)
		}
	}
}

// Grouping is presentation. Refusing one item in the batch must not refuse the
// others, or asking once would quietly become a blanket decision.
func TestDenyingOneOfABatchLeavesTheRest(t *testing.T) {
	dir := t.TempDir()
	fake := testutil.NewFakeOmniRoute(t,
		testutil.FakeStep{ToolCalls: []gateway.ToolCall{
			writeCall("w1", "keep.txt", "1"),
			writeCall("w2", "secrets.env", "2"),
			writeCall("w3", "also-keep.txt", "3"),
		}},
		testutil.FakeStep{Content: "done"},
	)
	deps := testDeps(t, fake, dir)
	ap := &batchCountingApprover{deny: map[string]bool{"secrets.env": true}}
	deps.Policy = policy.NewEngine(policy.Config{
		RiskAction:   map[string]string{"low": "allow", "medium": "ask", "high": "ask", "critical": "block"},
		ShellAllowed: true,
	}, ap)

	if _, err := runAgent(t, deps, task.Spec{Prompt: "write three files", CWD: dir}, RoleImplementer); err != nil {
		t.Fatalf("run: %v", err)
	}
	for _, name := range []string{"keep.txt", "also-keep.txt"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Errorf("%s was approved and should exist: %v", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "secrets.env")); err == nil {
		t.Error("the denied write happened anyway")
	}
}

// Hooks and validation run once per call, not once per policy pass. Splitting
// planning from running is the reason this holds — if the plan re-ran hooks
// when the loop reached each call, a counting hook would see doubles.
func TestHooksRunExactlyOncePerCallInATurn(t *testing.T) {
	dir := t.TempDir()
	fake := testutil.NewFakeOmniRoute(t,
		testutil.FakeStep{ToolCalls: []gateway.ToolCall{
			writeCall("w1", "a.txt", "1"), writeCall("w2", "b.txt", "2"), writeCall("w3", "c.txt", "3"),
		}},
		testutil.FakeStep{Content: "done"},
	)
	deps := testDeps(t, fake, dir)

	var seen int32
	hooks := hook.NewRegistry()
	_ = hooks.Add(hook.Func{
		HookName: "counter",
		At:       []hook.Point{hook.BeforeTool},
		Fn: func(context.Context, hook.Call) error {
			atomic.AddInt32(&seen, 1)
			return nil
		},
	})
	deps.Hooks = hooks

	if _, err := runAgent(t, deps, task.Spec{Prompt: "write three files", CWD: dir}, RoleImplementer); err != nil {
		t.Fatalf("run: %v", err)
	}
	if got := atomic.LoadInt32(&seen); got != 3 {
		t.Fatalf("the hook saw %d calls for a 3-call turn", got)
	}
}
