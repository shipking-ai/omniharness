package runtime

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"

	"omniharness/internal/mcp"
	"omniharness/internal/testutil"
	"omniharness/internal/tools"
)

// Runs the published resolve-mcp server. Opt in with OMNIHARNESS_LIVE_MCP=1.
//
// DaVinci Resolve itself is NOT required and NOT exercised: it is not
// installed here. Like blender-mcp, the server answers initialize and
// tools/list without the application and reports the missing connection at
// call time, which is enough to pin the part that is the harness's business —
// registration, capability routing, schema validation and effect gating
// against a real third-party surface of 200-odd tools.
func TestRealResolveServerRegistersAndGates(t *testing.T) {
	if os.Getenv("OMNIHARNESS_LIVE_MCP") != "1" {
		t.Skip("set OMNIHARNESS_LIVE_MCP=1 to run against a real MCP server")
	}
	if _, err := exec.LookPath("uvx"); err != nil {
		t.Skip("uvx not available")
	}

	fake := testutil.NewFakeOmniRoute(t, testutil.FakeStep{Content: "done"})
	rt := testRuntime(t, fake, t.TempDir())
	err := rt.LoadMCPServers(context.Background(), []mcp.Server{{
		Name: "resolve", Command: "uvx", Args: []string{"resolve-mcp"},
		Capabilities: []string{"edit_video"},
		ToolCapabilities: map[string][]string{
			"resolve_import_media":     {"import_media"},
			"resolve_add_render_job":   {"render_video"},
			"resolve_copy_grade":       {"color_grade"},
			"resolve_add_markers":      {"edit_timeline"},
			"resolve_delete_timelines": {"edit_timeline"},
		},
		ToolEffects: map[string][]string{
			// These say "WARNING: cannot be undone" in their own descriptions.
			"resolve_delete_timelines": {"destructive"},
			"resolve_delete_project":   {"destructive"},
			"resolve_delete_clips":     {"destructive"},
			"resolve_list_projects":    {"read_only"},
		},
	}})
	if err != nil {
		t.Fatalf("LoadMCPServers: %v", err)
	}

	registered := rt.Tools.WithProvider("mcp:resolve")
	if len(registered) < 100 {
		t.Fatalf("registered %d tools from resolve-mcp, want its full surface", len(registered))
	}

	// Per-tool capabilities: the point of not using one server-level list.
	if got := rt.Tools.WithCapability("color_grade"); len(got) != 1 || got[0].Name != "mcp:resolve:resolve_copy_grade" {
		t.Errorf("WithCapability(color_grade) = %v, want only the grade tool", specNames(got))
	}
	if !rt.Tools.HasCapability("render_video") || !rt.Tools.HasCapability("import_media") {
		t.Error("the declared media capabilities are not indexed")
	}

	// Provenance from the handshake, not from the operator's chosen name.
	sample, ok := rt.Tools.Get("mcp:resolve:resolve_list_projects")
	if !ok {
		t.Fatal("resolve_list_projects did not register")
	}
	if !strings.Contains(sample.Spec().Version, "resolve-mcp") {
		t.Errorf("Version = %q, want the server's reported name and version", sample.Spec().Version)
	}

	// A tool whose own description warns it cannot be undone must be gated,
	// however permissive the risk table is.
	del, ok := rt.Tools.Get("mcp:resolve:resolve_delete_timelines")
	if !ok {
		t.Fatal("resolve_delete_timelines did not register")
	}
	if !del.Spec().HasEffect(tools.EffectDestructive) {
		t.Error("resolve_delete_timelines is not declared destructive")
	}
	if len(del.Spec().GatedEffects()) == 0 {
		t.Error("a destructive tool produced no gated effects, so policy would not prompt")
	}

	// The real schema is enforced before anything reaches the server.
	if err := tools.ValidateInput(del.Spec(), map[string]any{}); err == nil {
		t.Error("a delete with no timeline names was accepted")
	} else if !strings.Contains(err.Error(), "timeline_names") {
		t.Errorf("rejection %q does not name the missing argument", err)
	}
	if err := tools.ValidateInput(del.Spec(), map[string]any{"timeline_names": "a,b"}); err != nil {
		t.Errorf("a valid call was rejected: %v", err)
	}
}
