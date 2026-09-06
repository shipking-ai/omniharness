package tools

import "testing"

func TestUnregisterRemovesATool(t *testing.T) {
	r := NewRegistry()
	mustRegisterCap(t, r, &capStubTool{Spec{Name: "gone", Capabilities: []Capability{"render_scene"}}})
	if !r.HasCapability("render_scene") {
		t.Fatal("setup: capability missing")
	}
	if !r.Unregister("gone") {
		t.Fatal("Unregister reported the tool was absent")
	}
	if _, ok := r.Get("gone"); ok {
		t.Error("Get still returns an unregistered tool")
	}
	if r.HasCapability("render_scene") {
		t.Error("the capability index still reports a removed tool's capability")
	}
	if r.Unregister("gone") {
		t.Error("Unregister reported success for an absent tool")
	}
	// The name must be reusable: a provider that restarts re-registers.
	if err := r.Register(&capStubTool{Spec{Name: "gone"}}); err != nil {
		t.Errorf("cannot re-register a removed name: %v", err)
	}
}

func TestUnregisterProviderRemovesOnlyThatProvider(t *testing.T) {
	r := NewRegistry()
	mustRegisterCap(t, r, &capStubTool{Spec{Name: "native_read", Provider: ProviderNative}})
	mustRegisterCap(t, r, &capStubTool{Spec{Name: "mcp:blender:render", Provider: "mcp:blender"}})
	mustRegisterCap(t, r, &capStubTool{Spec{Name: "mcp:blender:scene", Provider: "mcp:blender"}})
	mustRegisterCap(t, r, &capStubTool{Spec{Name: "mcp:other:thing", Provider: "mcp:other"}})

	removed := r.UnregisterProvider("mcp:blender")
	if len(removed) != 2 || removed[0] != "mcp:blender:render" || removed[1] != "mcp:blender:scene" {
		t.Fatalf("UnregisterProvider = %v, want both blender tools in name order", removed)
	}
	left := r.Names()
	if len(left) != 2 || left[0] != "mcp:other:thing" || left[1] != "native_read" {
		t.Fatalf("remaining tools = %v, want the other provider and the native tool untouched", left)
	}
}

// An empty provider must not match the native tools or anything else that
// simply left the field unset — that would empty the registry.
func TestUnregisterProviderIgnoresTheEmptyProvider(t *testing.T) {
	r := NewRegistry()
	mustRegisterCap(t, r, &capStubTool{Spec{Name: "unlabelled"}})
	if removed := r.UnregisterProvider(""); removed != nil {
		t.Fatalf("UnregisterProvider(\"\") removed %v, want nothing", removed)
	}
	if len(r.Names()) != 1 {
		t.Fatal("an empty provider argument emptied the registry")
	}
}
