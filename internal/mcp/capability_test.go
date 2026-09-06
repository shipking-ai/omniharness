package mcp

import (
	"testing"

	"omniharness/internal/tools"
)

func adapterFor(srv Server, info ToolInfo) *ToolAdapter {
	return &ToolAdapter{Client: NewClient(srv), Info: info}
}

func TestAdapterUsesDeclaredCapabilities(t *testing.T) {
	a := adapterFor(
		Server{Name: "blender", Command: "blender-mcp", Capabilities: []string{"create_3d_scene", " render_scene "}},
		ToolInfo{Name: "render"},
	)
	spec := a.Spec()
	if len(spec.Capabilities) != 2 || spec.Capabilities[0] != "create_3d_scene" || spec.Capabilities[1] != "render_scene" {
		t.Fatalf("Spec().Capabilities = %v, want trimmed [create_3d_scene render_scene]", spec.Capabilities)
	}
	if spec.Provider != "mcp:blender" {
		t.Errorf("Spec().Provider = %q, want %q", spec.Provider, "mcp:blender")
	}
}

// A server that declares nothing still has to be reachable, so the adapter
// falls back rather than emitting an empty set.
func TestAdapterFallsBackToExternalTool(t *testing.T) {
	a := adapterFor(Server{Name: "misc", Command: "x"}, ToolInfo{Name: "do"})
	got := a.Spec().Capabilities
	if len(got) != 1 || got[0] != tools.CapExternalTool {
		t.Fatalf("Spec().Capabilities = %v, want [%s]", got, tools.CapExternalTool)
	}
}

// Defense in depth: a Server built in code rather than loaded from config
// bypasses ValidateCapabilities, and a malformed name must not reach the
// registry.
func TestAdapterDropsMalformedCapabilities(t *testing.T) {
	a := adapterFor(Server{Name: "misc", Command: "x", Capabilities: []string{"Bad Name", "ok_name"}}, ToolInfo{Name: "do"})
	got := a.Spec().Capabilities
	if len(got) != 1 || got[0] != "ok_name" {
		t.Fatalf("Spec().Capabilities = %v, want only [ok_name]", got)
	}
	a = adapterFor(Server{Name: "misc", Command: "x", Capabilities: []string{"Bad Name"}}, ToolInfo{Name: "do"})
	if got := a.Spec().Capabilities; len(got) != 1 || got[0] != tools.CapExternalTool {
		t.Fatalf("all-invalid declaration gave %v, want the external_tool fallback", got)
	}
}

func TestValidateCapabilitiesRejectsTypos(t *testing.T) {
	err := ValidateCapabilities(Server{Name: "blender", Capabilities: []string{"render_scene", "Render Scene"}})
	if err == nil {
		t.Fatal("ValidateCapabilities accepted a malformed capability")
	}
	if !contains(err.Error(), "blender") {
		t.Errorf("error %q does not name the server, so an operator cannot find the config line", err)
	}
	if err := ValidateCapabilities(Server{Name: "ok", Capabilities: []string{"render_scene"}}); err != nil {
		t.Errorf("ValidateCapabilities rejected a valid declaration: %v", err)
	}
	if err := ValidateCapabilities(Server{Name: "ok"}); err != nil {
		t.Errorf("ValidateCapabilities rejected an empty declaration: %v", err)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
