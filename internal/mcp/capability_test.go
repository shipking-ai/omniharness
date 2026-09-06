package mcp

import (
	"context"
	"testing"
	"time"

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
	// Declared names first, for discovery; external_tool last, because that is
	// what the acting roles actually match on. Describing a server must never
	// make it less reachable than leaving it undescribed.
	want := []tools.Capability{"create_3d_scene", "render_scene", tools.CapExternalTool}
	if len(spec.Capabilities) != len(want) {
		t.Fatalf("Spec().Capabilities = %v, want %v", spec.Capabilities, want)
	}
	for i, c := range want {
		if spec.Capabilities[i] != c {
			t.Fatalf("Spec().Capabilities = %v, want %v", spec.Capabilities, want)
		}
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
	if len(got) != 2 || got[0] != "ok_name" || got[1] != tools.CapExternalTool {
		t.Fatalf("Spec().Capabilities = %v, want [ok_name external_tool]", got)
	}
	a = adapterFor(Server{Name: "misc", Command: "x", Capabilities: []string{"Bad Name"}}, ToolInfo{Name: "do"})
	if got := a.Spec().Capabilities; len(got) != 1 || got[0] != tools.CapExternalTool {
		t.Fatalf("all-invalid declaration gave %v, want just external_tool", got)
	}
	// external_tool must not be duplicated when an operator names it too.
	a = adapterFor(Server{Name: "misc", Command: "x", Capabilities: []string{"external_tool", "ok_name"}}, ToolInfo{Name: "do"})
	if got := a.Spec().Capabilities; len(got) != 2 {
		t.Fatalf("Spec().Capabilities = %v, want no duplicate external_tool", got)
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

func TestAliveTracksTheServerProcess(t *testing.T) {
	c := startFake(t)
	if !c.Alive() {
		t.Fatal("a freshly started server reports not alive")
	}
	select {
	case <-c.Done():
		t.Fatal("Done fired while the server was still running")
	default:
	}

	if err := c.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	// Close ends the process; readLoop closes done when stdout closes.
	select {
	case <-c.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("Done never fired after the server exited")
	}
	if c.Alive() {
		t.Error("Alive is still true after the server exited")
	}
}

// A client that was never started has no process to be alive.
func TestUnstartedClientIsNotAlive(t *testing.T) {
	if NewClient(Server{Name: "never", Command: "x"}).Alive() {
		t.Error("an unstarted client reports alive")
	}
}

// A dead server and a failed tool call are different situations: one is worth
// retrying, the other never is.
func TestAdapterReportsUnavailableWhenServerIsGone(t *testing.T) {
	c := startFake(t)
	infos, err := c.ListTools(context.Background())
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	a := &ToolAdapter{Client: c, Info: infos[0]}

	// While alive, a tool the server rejects is an ordinary failure.
	_, err = (&ToolAdapter{Client: c, Info: ToolInfo{Name: "boom"}}).Run(context.Background(), map[string]any{})
	if err == nil {
		t.Fatal("a server-reported tool error did not surface")
	}
	if got := tools.KindOf(err); got != tools.ErrFailed {
		t.Errorf("a live server's tool failure has kind %s, want %s", got, tools.ErrFailed)
	}

	c.Close()
	select {
	case <-c.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("server did not exit")
	}
	_, err = a.Run(context.Background(), map[string]any{})
	if err == nil {
		t.Fatal("a call to a dead server succeeded")
	}
	if got := tools.KindOf(err); got != tools.ErrUnavailable {
		t.Errorf("a dead server's error has kind %s, want %s", got, tools.ErrUnavailable)
	}
}
