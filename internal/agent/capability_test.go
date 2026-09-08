package agent

import (
	"context"
	"strings"
	"testing"

	"omniharness/internal/event"
	"omniharness/internal/gateway"
	"omniharness/internal/policy"
	"omniharness/internal/session"
	"omniharness/internal/task"
	"omniharness/internal/tools"
)

// The bug this fixes: MCP tools register under a runtime-generated name
// ("mcp:<server>:<tool>"), and every default role carried a non-empty
// ToolAllow listing only native names. The tool loaded, appeared in
// `omniharness plugins`, and was never offered to a single model. Capability
// matching is what makes it reachable, so this asserts reach, not wiring.
func TestExternalToolIsReachableByCapability(t *testing.T) {
	external := tools.Spec{
		Name:         "mcp:blender:render",
		Provider:     "mcp:blender",
		Capabilities: []tools.Capability{"render_scene"},
	}
	generic := tools.Spec{
		Name:         "mcp:whatever:do_thing",
		Provider:     "mcp:whatever",
		Capabilities: []tools.Capability{tools.CapExternalTool},
	}

	roles := DefaultRoles()

	// A capability nothing declares reaches nobody — reach is earned by a
	// declaration, not granted by being external.
	for role, cfg := range roles {
		if cfg.AllowsTool(external) {
			t.Errorf("role %s reaches render_scene, which no role declares", role)
		}
	}

	// The generic fallback reaches the acting roles, which is what makes a
	// server that declared nothing usable at all.
	var reached []Role
	for role, cfg := range roles {
		if cfg.AllowsTool(generic) {
			reached = append(reached, role)
		}
	}
	if len(reached) == 0 {
		t.Fatal("no role can call an MCP tool with the default external_tool capability; MCP is unreachable")
	}
	for _, want := range []Role{RoleImplementer, RoleResearcher, RoleDebugger, RoleTester, RoleOptimizer} {
		if !roles[want].AllowsTool(generic) {
			t.Errorf("role %s cannot reach a generic external tool", want)
		}
	}
	// Read-only roles stay narrow: an undescribed external tool could do
	// anything, so a reviewer or auditor does not get one by default.
	for _, deny := range []Role{RoleReviewer, RoleSecurityAuditor, RoleSynthesizer, RoleArchitect} {
		if roles[deny].AllowsTool(generic) {
			t.Errorf("role %s reaches a generic external tool; it should not", deny)
		}
	}
}

// A role that declares a capability reaches any tool providing it, whatever
// program that tool comes from. This is the extensibility contract.
func TestRoleReachesAnyProviderOfADeclaredCapability(t *testing.T) {
	cfg := RoleConfig{Capabilities: []tools.Capability{tools.CapExecuteCode}}
	for _, spec := range []tools.Spec{
		{Name: "shell", Provider: tools.ProviderNative, Capabilities: []tools.Capability{tools.CapExecuteCode}},
		{Name: "mcp:blender:execute_python", Provider: "mcp:blender", Capabilities: []tools.Capability{tools.CapExecuteCode}},
	} {
		if !cfg.AllowsTool(spec) {
			t.Errorf("role declaring execute_code cannot reach %q", spec.Name)
		}
	}
	if cfg.AllowsTool(tools.Spec{Name: "write_file", Capabilities: []tools.Capability{tools.CapWriteFiles}}) {
		t.Error("role declaring only execute_code reached a write_files tool")
	}
}

// Both lists empty keeps the pre-capability meaning: unrestricted.
func TestEmptyRoleConfigAllowsEverything(t *testing.T) {
	var cfg RoleConfig
	if !cfg.AllowsTool(tools.Spec{Name: "anything"}) {
		t.Error("a role with no ToolAllow and no Capabilities should allow every tool")
	}
}

// ToolAllow still works on its own, so a role can name one specific tool
// without opening up its whole capability.
func TestToolAllowStillGrantsByName(t *testing.T) {
	cfg := RoleConfig{ToolAllow: []string{"read_file"}}
	if !cfg.AllowsTool(tools.Spec{Name: "read_file"}) {
		t.Error("named tool not allowed")
	}
	if cfg.AllowsTool(tools.Spec{Name: "list_dir", Capabilities: []tools.Capability{tools.CapReadFiles}}) {
		t.Error("a name-only role reached a tool it did not name")
	}
}

// Every default role's capability set must cover the native tools it names,
// or the two mechanisms disagree about what the role can do.
func TestDefaultRoleCapabilitiesCoverTheirNamedTools(t *testing.T) {
	reg := tools.NewRegistry()
	native := tools.NewNative(t.TempDir())
	if err := native.Register(reg); err != nil {
		t.Fatalf("Register: %v", err)
	}
	byName := map[string]tools.Spec{}
	for _, s := range reg.List() {
		byName[s.Name] = s
	}
	for role, cfg := range DefaultRoles() {
		if len(cfg.Capabilities) == 0 {
			t.Errorf("role %s declares no capabilities", role)
		}
		for _, name := range cfg.ToolAllow {
			spec, ok := byName[name]
			if !ok {
				continue // "remember" is absent without a memory store
			}
			matched := false
			for _, want := range cfg.Capabilities {
				for _, have := range spec.Capabilities {
					if have == want {
						matched = true
					}
				}
			}
			if !matched {
				t.Errorf("role %s names tool %q but declares none of its capabilities %v",
					role, name, spec.Capabilities)
			}
		}
	}
}

// The end-to-end guard for the reachability bug: a registry that holds both
// native tools and an MCP-shaped tool must offer the MCP tool to the model.
// toolSpecs is the exact function that decides what a model is shown, so this
// asserts the offer, not just the predicate above it.
func TestMCPToolIsOfferedToTheModel(t *testing.T) {
	reg := tools.NewRegistry()
	native := tools.NewNative(t.TempDir())
	if err := native.Register(reg); err != nil {
		t.Fatalf("Register: %v", err)
	}
	if err := reg.Register(&fakeExternalTool{tools.Spec{
		Name:         "mcp:blender:render",
		Description:  "render the current scene",
		Provider:     "mcp:blender",
		Capabilities: []tools.Capability{tools.CapExternalTool},
	}}); err != nil {
		t.Fatalf("Register mcp tool: %v", err)
	}

	ag := New(Deps{Tools: reg, Roles: DefaultRoles()}, "s", "t", RoleImplementer, "", task.Spec{}, task.Profile{})
	offered := map[string]bool{}
	for _, spec := range ag.toolSpecs(DefaultRoles()[RoleImplementer]) {
		offered[spec.Function.Name] = true
	}
	if !offered["mcp:blender:render"] {
		t.Fatal("the implementer was not offered the MCP tool; it is registered but unreachable")
	}
	// The native set must be unchanged by the switch to capability matching.
	for _, name := range []string{"read_file", "write_file", "edit_file", "shell", "git", "search"} {
		if !offered[name] {
			t.Errorf("the implementer lost access to native tool %q", name)
		}
	}
	// And a role that should not reach an undescribed external tool still does not.
	offered = map[string]bool{}
	for _, spec := range ag.toolSpecs(DefaultRoles()[RoleSecurityAuditor]) {
		offered[spec.Function.Name] = true
	}
	if offered["mcp:blender:render"] {
		t.Error("the security auditor was offered an undescribed external tool")
	}
	if offered["write_file"] {
		t.Error("the security auditor was offered write_file")
	}
}

type fakeExternalTool struct{ spec tools.Spec }

func (f *fakeExternalTool) Spec() tools.Spec { return f.spec }
func (f *fakeExternalTool) Run(ctx context.Context, in map[string]any) (tools.Result, error) {
	return tools.Result{}, nil
}

// A malformed call must be rejected before policy sees it: asking a human to
// approve an action whose arguments are incoherent is asking them to sanction
// something that was never going to happen.
func TestInvalidToolCallIsRejectedBeforePolicy(t *testing.T) {
	reg := tools.NewRegistry()
	if err := tools.NewNative(t.TempDir()).Register(reg); err != nil {
		t.Fatal(err)
	}
	asked := 0
	pol := policy.NewEngine(policy.Config{
		RiskAction: map[string]string{"low": "ask", "medium": "ask", "high": "ask", "critical": "block"},
	}, policy.ApproverFunc(func(context.Context, policy.Request, string) (bool, error) {
		asked++
		return true, nil
	}))

	store, err := session.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	ag := New(Deps{Tools: reg, Roles: DefaultRoles(), Policy: pol, Store: store, Bus: event.NewBus()},
		"s", "t", RoleImplementer, "", task.Spec{}, task.Profile{})

	// read_file requires "path"; this call omits it.
	var missing gateway.ToolCall
	missing.Function.Name = "read_file"
	missing.Function.Arguments = `{}`
	out := ag.executeToolCall(context.Background(), missing, DefaultRoles()[RoleImplementer])

	if asked != 0 {
		t.Errorf("the approver was consulted %d time(s) for a call that could not run", asked)
	}
	if !strings.Contains(out, "path") {
		t.Errorf("the model was told %q, which does not name the missing argument", out)
	}
	if !strings.Contains(out, string(tools.ErrInvalidInput)) {
		t.Errorf("the model was told %q, which does not carry the error kind", out)
	}
	if !strings.Contains(out, tools.ErrInvalidInput.Guidance()) {
		t.Errorf("the model was told %q, without guidance on what to do next", out)
	}

	// A well-formed call still reaches policy.
	var valid gateway.ToolCall
	valid.Function.Name = "list_dir"
	valid.Function.Arguments = `{"path":"."}`
	_ = ag.executeToolCall(context.Background(), valid, DefaultRoles()[RoleImplementer])
	if asked == 0 {
		t.Error("a valid call never reached the approver")
	}
}

// The transcript deliberately keeps the assistant tool_calls message before
// the tool results, because the wire format rejects a tool message with no
// matching assistant message before it. Composition must not undo that.
func TestCompositionKeepsToolCallsWithTheirResults(t *testing.T) {
	var assistant gateway.Message
	assistant.Role = "assistant"
	assistant.ToolCalls = []gateway.ToolCall{toolCallFor("c1", "read_file")}
	transcript := []gateway.Message{
		{Role: "user", Content: "read it"},
		assistant,
		{Role: "tool", ToolCallID: "c1", Name: "read_file", Content: "contents"},
	}

	out := toGatewayMessages(toContextMessages(transcript))
	if len(out) != 3 {
		t.Fatalf("got %d messages, want 3", len(out))
	}
	if len(out[1].ToolCalls) != 1 || out[1].ToolCalls[0].ID != "c1" {
		t.Fatal("the assistant message lost its tool_calls, orphaning the tool result that follows")
	}
	if out[2].ToolCallID != "c1" {
		t.Errorf("the tool result lost its call id: %+v", out[2])
	}
}

// An image observation has to survive the same trip, or attaching one is
// pointless.
func TestCompositionKeepsImages(t *testing.T) {
	transcript := []gateway.Message{
		{Role: "user", Content: "look", Images: []gateway.ImageRef{
			{MimeType: "image/png", Data: []byte{1, 2, 3}, Source: "shot.png"},
		}},
	}
	out := toGatewayMessages(toContextMessages(transcript))
	if len(out) != 1 || len(out[0].Images) != 1 {
		t.Fatalf("the image did not survive composition: %+v", out)
	}
	if out[0].Images[0].MimeType != "image/png" || len(out[0].Images[0].Data) != 3 {
		t.Errorf("the image was altered: %+v", out[0].Images[0])
	}
}

func toolCallFor(id, name string) gateway.ToolCall {
	var tc gateway.ToolCall
	tc.ID = id
	tc.Type = "function"
	tc.Function.Name = name
	tc.Function.Arguments = "{}"
	return tc
}
