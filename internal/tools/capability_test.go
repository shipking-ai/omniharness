package tools

import (
	"context"
	"testing"
)

func TestValidateCapabilityShape(t *testing.T) {
	valid := []Capability{"read_files", "create_3d_scene", "a", "x1", "color_grade"}
	for _, c := range valid {
		if err := ValidateCapability(c); err != nil {
			t.Errorf("ValidateCapability(%q) = %v, want nil", c, err)
		}
	}
	invalid := []Capability{"", "ReadFiles", "read-files", "read files", "3d_scene", "read.files", "_read"}
	for _, c := range invalid {
		if err := ValidateCapability(c); err == nil {
			t.Errorf("ValidateCapability(%q) = nil, want an error", c)
		}
	}
}

// The vocabulary is open on purpose: a capability nothing in this build has
// heard of must validate, because that is how an external adapter declares
// what it provides without a core change.
func TestValidateCapabilityAcceptsUnknownNames(t *testing.T) {
	for _, c := range []Capability{"create_3d_scene", "generate_music", "color_grade"} {
		if err := ValidateCapability(c); err != nil {
			t.Errorf("unknown capability %q rejected: %v", c, err)
		}
	}
}

func TestParseCapabilitiesReportsFirstInvalid(t *testing.T) {
	if _, err := ParseCapabilities([]string{"render_scene", "Bad Name"}); err == nil {
		t.Fatal("ParseCapabilities accepted an invalid name")
	}
	got, err := ParseCapabilities([]string{" render_scene ", "generate_image"})
	if err != nil {
		t.Fatalf("ParseCapabilities: %v", err)
	}
	if len(got) != 2 || got[0] != "render_scene" || got[1] != "generate_image" {
		t.Fatalf("ParseCapabilities = %v, want trimmed [render_scene generate_image]", got)
	}
}

// capStubTool is a minimal Tool for registry tests.
type capStubTool struct{ spec Spec }

func (s *capStubTool) Spec() Spec { return s.spec }
func (s *capStubTool) Run(ctx context.Context, in map[string]any) (Result, error) {
	return Result{}, nil
}

func TestRegistryCapabilityDiscovery(t *testing.T) {
	r := NewRegistry()
	mustRegisterCap(t, r, &capStubTool{Spec{Name: "b_render", Capabilities: []Capability{"render_scene", "execute_code"}}})
	mustRegisterCap(t, r, &capStubTool{Spec{Name: "a_shell", Capabilities: []Capability{"execute_code"}}})
	mustRegisterCap(t, r, &capStubTool{Spec{Name: "c_plain"}})

	got := r.WithCapability("execute_code")
	if len(got) != 2 || got[0].Name != "a_shell" || got[1].Name != "b_render" {
		t.Fatalf("WithCapability(execute_code) = %v, want [a_shell b_render] in name order", specNames(got))
	}
	if !r.HasCapability("render_scene") {
		t.Error("HasCapability(render_scene) = false, want true")
	}
	if r.HasCapability("generate_music") {
		t.Error("HasCapability(generate_music) = true, but nothing provides it")
	}
	caps := r.Capabilities()
	if len(caps) != 2 || caps[0] != "execute_code" || caps[1] != "render_scene" {
		t.Fatalf("Capabilities() = %v, want sorted, deduplicated [execute_code render_scene]", caps)
	}
}

// Every native tool must declare at least one capability. A native tool with
// none is reachable only by the name lists in agent.DefaultRoles, which is the
// coupling capabilities exist to remove.
func TestNativeToolsAllDeclareCapabilities(t *testing.T) {
	r := NewRegistry()
	n := NewNative(t.TempDir())
	if err := n.Register(r); err != nil {
		t.Fatalf("Register: %v", err)
	}
	for _, spec := range r.List() {
		if len(spec.Capabilities) == 0 {
			t.Errorf("native tool %q declares no capabilities", spec.Name)
		}
		for _, c := range spec.Capabilities {
			if err := ValidateCapability(c); err != nil {
				t.Errorf("native tool %q: %v", spec.Name, err)
			}
		}
		if spec.Provider != ProviderNative {
			t.Errorf("native tool %q has provider %q, want %q", spec.Name, spec.Provider, ProviderNative)
		}
	}
	if !r.HasCapability(CapExecuteCode) {
		t.Error("no native tool provides execute_code, but shell should")
	}
}

func mustRegisterCap(t *testing.T, r *Registry, tool Tool) {
	t.Helper()
	if err := r.Register(tool); err != nil {
		t.Fatalf("Register(%s): %v", tool.Spec().Name, err)
	}
}

func specNames(in []Spec) []string {
	out := make([]string, len(in))
	for i, s := range in {
		out[i] = s.Name
	}
	return out
}
