package agent

import (
	"strings"
	"testing"

	"omniharness/internal/model"
	"omniharness/internal/tools"
)

// Creative roles must be able to reach external tool providers — that is the
// entire reason they can exist. A creative role that can only touch the native
// filesystem tools cannot make anything.
func TestCreativeRolesReachExternalProviders(t *testing.T) {
	external := tools.Spec{
		Name:         "mcp:blender:render",
		Provider:     "mcp:blender",
		Capabilities: []tools.Capability{"render_scene", tools.CapExternalTool},
	}
	roles := DefaultRoles()
	for _, r := range []Role{RoleCreativeDirector, RoleAssetProducer} {
		cfg, ok := roles[r]
		if !ok {
			t.Fatalf("role %s is not defined", r)
		}
		if !cfg.AllowsTool(external) {
			t.Errorf("role %s cannot reach an external provider", r)
		}
	}
}

// The director judges, it does not build. A role that can overwrite the asset
// it is supposed to be assessing is not an independent check.
func TestCreativeDirectorCannotWriteAssets(t *testing.T) {
	cfg := DefaultRoles()[RoleCreativeDirector]
	write := tools.Spec{Name: "write_file", Capabilities: []tools.Capability{tools.CapWriteFiles}}
	if cfg.AllowsTool(write) {
		t.Error("the creative director can write files; it is supposed to judge, not produce")
	}
	shell := tools.Spec{Name: "shell", Capabilities: []tools.Capability{tools.CapExecuteCode}}
	if cfg.AllowsTool(shell) {
		t.Error("the creative director can run shell commands")
	}
	// The producer, by contrast, must be able to make things.
	producer := DefaultRoles()[RoleAssetProducer]
	if !producer.AllowsTool(write) {
		t.Error("the asset producer cannot write files")
	}
}

// Both creative roles ask for vision. Judging a render you cannot see is the
// failure mode this whole line of work exists to remove.
func TestCreativeRolesAskForVision(t *testing.T) {
	for _, r := range []Role{RoleCreativeDirector, RoleAssetProducer} {
		cfg := DefaultRoles()[r]
		found := false
		for _, c := range cfg.ModelIntent.Capabilities {
			if c == model.CapVision {
				found = true
			}
		}
		if !found {
			t.Errorf("role %s does not ask for a vision-capable model: %v", r, cfg.ModelIntent.Capabilities)
		}
	}
}

// Creative prompts must not be software prompts. Before these roles existed, a
// creative task was handed to the implementer and told to "make minimal,
// correct changes" and "name files, functions and interfaces".
func TestCreativePromptsAreNotSoftwarePrompts(t *testing.T) {
	for _, r := range []Role{RoleCreativeDirector, RoleAssetProducer} {
		p := strings.ToLower(DefaultRoles()[r].Prompt)
		if p == "" {
			t.Fatalf("role %s has no prompt", r)
		}
		for _, word := range []string{"code", "function", "refactor", "test suite", "compile"} {
			if strings.Contains(p, word) {
				t.Errorf("role %s prompt contains software framing %q", r, word)
			}
		}
	}
}

// Every role, creative ones included, must keep the two tools the runtime
// depends on.
func TestCreativeRolesKeepRuntimeTools(t *testing.T) {
	for _, r := range []Role{RoleCreativeDirector, RoleAssetProducer} {
		cfg := DefaultRoles()[r]
		for _, name := range []string{"remember", "request_replan"} {
			if !cfg.AllowsTool(tools.Spec{Name: name}) {
				t.Errorf("role %s cannot call %q", r, name)
			}
		}
	}
}

// AllRoles must list them, or anything iterating roles silently skips them.
func TestAllRolesIncludesCreativeRoles(t *testing.T) {
	listed := map[Role]bool{}
	for _, r := range AllRoles() {
		listed[r] = true
	}
	for _, r := range []Role{RoleCreativeDirector, RoleAssetProducer} {
		if !listed[r] {
			t.Errorf("AllRoles omits %s", r)
		}
	}
	if len(AllRoles()) != len(DefaultRoles()) {
		t.Errorf("AllRoles has %d entries, DefaultRoles has %d", len(AllRoles()), len(DefaultRoles()))
	}
}
