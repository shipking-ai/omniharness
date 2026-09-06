package agent

import (
	"context"
	"testing"

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
