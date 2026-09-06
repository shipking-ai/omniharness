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

// This is the only test that runs a real third-party MCP server. It downloads
// and executes blender-mcp through uvx, so it is opt-in: set
// OMNIHARNESS_LIVE_MCP=1 to run it. Everything else in the suite uses local
// fakes and stays hermetic.
//
// It does NOT need Blender. The server answers initialize and tools/list
// without it and reports the missing connection at call time, which is exactly
// the surface worth pinning: real handshake, real schemas, real failure text.
func requireLiveMCP(t *testing.T) {
	t.Helper()
	if os.Getenv("OMNIHARNESS_LIVE_MCP") != "1" {
		t.Skip("set OMNIHARNESS_LIVE_MCP=1 to run against a real MCP server")
	}
	if _, err := exec.LookPath("uvx"); err != nil {
		t.Skip("uvx not available")
	}
}

func TestRealMCPServerRegistersAndValidates(t *testing.T) {
	requireLiveMCP(t)
	fake := testutil.NewFakeOmniRoute(t, testutil.FakeStep{Content: "done"})
	rt := testRuntime(t, fake, t.TempDir())

	err := rt.LoadMCPServers(context.Background(), []mcp.Server{{
		Name: "blender", Command: "uvx", Args: []string{"blender-mcp"},
		Capabilities: []string{"execute_code"},
		ToolCapabilities: map[string][]string{
			"get_scene_info":          {"inspect_3d_scene"},
			"get_viewport_screenshot": {"inspect_3d_scene", "render_scene"},
			"execute_blender_code":    {"modify_3d_scene", "execute_code"},
		},
	}})
	if err != nil {
		t.Fatalf("LoadMCPServers: %v", err)
	}

	registered := rt.Tools.WithProvider("mcp:blender")
	if len(registered) < 20 {
		t.Fatalf("registered %d tools from the real server, want its full surface", len(registered))
	}

	// Per-tool capabilities are the whole point: a server-level declaration
	// would give all 28 tools every capability and make discovery useless.
	if got := rt.Tools.WithCapability("render_scene"); len(got) != 1 || got[0].Name != "mcp:blender:get_viewport_screenshot" {
		t.Errorf("WithCapability(render_scene) = %v, want only the screenshot tool", specNames(got))
	}
	if got := rt.Tools.WithCapability("inspect_3d_scene"); len(got) != 2 {
		t.Errorf("WithCapability(inspect_3d_scene) = %v, want the two tools declared for it", specNames(got))
	}

	// The real schema marks user_prompt required, so a call without it must be
	// rejected here rather than sent to the server.
	tool, ok := rt.Tools.Get("mcp:blender:get_scene_info")
	if !ok {
		t.Fatal("get_scene_info did not register")
	}
	spec := tool.Spec()
	if err := tools.ValidateInput(spec, map[string]any{}); err == nil {
		t.Error("a call missing the required user_prompt was accepted")
	} else if !strings.Contains(err.Error(), "user_prompt") {
		t.Errorf("rejection %q does not name the missing argument", err)
	}
	if err := tools.ValidateInput(spec, map[string]any{"user_prompt": "inspect the scene"}); err != nil {
		t.Errorf("a valid call was rejected: %v", err)
	}
	if spec.Description == "" {
		t.Error("the real server's tool description did not survive registration")
	}

	// Blender is not running. The server reports that in a text block with
	// isError false, so it reaches the model as readable output rather than a
	// protocol failure — which is right: the model can act on it.
	res, runErr := tool.Run(context.Background(), map[string]any{"user_prompt": "inspect the scene"})
	if runErr != nil && tools.KindOf(runErr) == tools.ErrUnavailable {
		t.Fatalf("a live server was misreported as unavailable: %v", runErr)
	}
	if runErr == nil && !strings.Contains(strings.ToLower(res.Output), "blender") {
		t.Errorf("output %q does not explain why the call could not do anything", res.Output)
	}
}
