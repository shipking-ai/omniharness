package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"omniharness/internal/config"
	"omniharness/internal/gateway"
	"omniharness/internal/mcp"
	"omniharness/internal/task"
	"omniharness/internal/testutil"
	"omniharness/internal/tools"
)

// These tests drive a real Blender through blender-mcp. Blender must already
// be running with the blender-mcp addon's socket server listening on
// 127.0.0.1:9876 — headless works, see docs/blender.md. Opt in with
// OMNIHARNESS_LIVE_BLENDER=1.
//
// Everything else in the suite is hermetic; nothing here runs by default.
func requireLiveBlender(t *testing.T) {
	t.Helper()
	if os.Getenv("OMNIHARNESS_LIVE_BLENDER") != "1" {
		t.Skip("set OMNIHARNESS_LIVE_BLENDER=1 and run Blender with the blender-mcp addon")
	}
	if _, err := exec.LookPath("uvx"); err != nil {
		t.Skip("uvx not available")
	}
	conn, err := net.DialTimeout("tcp", "127.0.0.1:9876", 2*time.Second)
	if err != nil {
		t.Skipf("no blender-mcp addon listening on 127.0.0.1:9876: %v", err)
	}
	conn.Close()
}

func blenderServer() mcp.Server {
	return mcp.Server{
		Name: "blender", Command: "uvx", Args: []string{"blender-mcp"},
		Capabilities: []string{"execute_code"},
		ToolCapabilities: map[string][]string{
			"get_scene_info":       {"inspect_3d_scene"},
			"execute_blender_code": {"modify_3d_scene", "execute_code"},
		},
	}
}

func blenderCall(id, name string, args map[string]any) gateway.ToolCall {
	raw, err := json.Marshal(args)
	if err != nil {
		panic(err)
	}
	var tc gateway.ToolCall
	tc.ID = id
	tc.Type = "function"
	tc.Function.Name = name
	tc.Function.Arguments = string(raw)
	return tc
}

// A full task through the harness against a real Blender: inspect the scene,
// change it, render it, and confirm the render is on disk. Every layer is the
// real one except the model, which is scripted so the run is deterministic.
func TestHarnessDrivesRealBlender(t *testing.T) {
	requireLiveBlender(t)
	workspace := t.TempDir()
	render := filepath.ToSlash(filepath.Join(workspace, "render.png"))

	// Ordinary bpy. The point is not the script; it is that the harness got
	// it there and Blender really executed it.
	code := "import bpy\n" +
		"bpy.ops.mesh.primitive_uv_sphere_add(radius=1.2, location=(0, 0, 3))\n" +
		"bpy.context.object.name = 'OmniHarnessProbe'\n" +
		"scene = bpy.context.scene\n" +
		// The render engine is left alone on purpose. Its identifier has
		// changed across Blender versions (BLENDER_EEVEE, BLENDER_EEVEE_NEXT,
		// and back again in 5.x), so pinning one makes this a test of the
		// Blender version rather than of the harness.
		"scene.render.resolution_x = 160\n" +
		"scene.render.resolution_y = 120\n" +
		"scene.render.filepath = '" + render + "'\n" +
		"bpy.ops.render.render(write_still=True)\n"

	fake := testutil.NewFakeOmniRoute(t,
		testutil.FakeStep{ToolCalls: []gateway.ToolCall{
			blenderCall("c1", "mcp:blender:get_scene_info", map[string]any{"user_prompt": "inspect the scene"})}},
		testutil.FakeStep{ToolCalls: []gateway.ToolCall{
			blenderCall("c2", "mcp:blender:execute_blender_code", map[string]any{
				"code": code, "user_prompt": "add a sphere and render it"})}},
		testutil.FakeStep{ToolCalls: []gateway.ToolCall{
			blenderCall("c3", "mcp:blender:get_scene_info", map[string]any{"user_prompt": "confirm the sphere exists"})}},
		testutil.FakeStep{Content: "Added the sphere and rendered the scene."},
	)
	rt := testRuntime(t, fake, workspace)
	if err := rt.LoadMCPServers(context.Background(), []mcp.Server{blenderServer()}); err != nil {
		t.Fatalf("LoadMCPServers: %v", err)
	}

	ss, err := rt.NewSession(workspace, "blender")
	if err != nil {
		t.Fatal(err)
	}
	tsk, err := rt.RunTask(context.Background(), ss.ID,
		"Add a sphere to the Blender scene and render it.", RunOptions{ApproveAll: true})
	if err != nil {
		t.Fatalf("RunTask: %v", err)
	}
	if tsk.Status != task.StatusCompleted {
		t.Fatalf("status = %s: %s", tsk.Status, tsk.Error)
	}

	calls, err := rt.Store.ToolCalls(ss.ID)
	if err != nil {
		t.Fatal(err)
	}
	completed := map[string]int{}
	for _, c := range calls {
		if c.Status == "completed" {
			completed[c.Tool]++
		} else if strings.HasPrefix(c.Tool, "mcp:blender:") {
			t.Errorf("%s ended %s: %s", c.Tool, c.Status, c.Error)
		}
	}
	if completed["mcp:blender:get_scene_info"] != 2 {
		t.Errorf("get_scene_info completed %d times, want 2", completed["mcp:blender:get_scene_info"])
	}
	if completed["mcp:blender:execute_blender_code"] != 1 {
		t.Errorf("execute_blender_code completed %d times, want 1", completed["mcp:blender:execute_blender_code"])
	}

	// Blender really rendered. The harness could not have produced this file.
	info, err := os.Stat(filepath.FromSlash(render))
	if err != nil {
		t.Fatalf("Blender did not write the render: %v", err)
	}
	raw, err := os.ReadFile(filepath.FromSlash(render))
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) < 8 || string(raw[1:4]) != "PNG" {
		t.Fatalf("the rendered file is not a PNG (%d bytes)", info.Size())
	}
	t.Logf("Blender rendered %d bytes to %s", info.Size(), render)
}

// State set by one call must still be there on the next: proof these are calls
// into one live Blender process rather than anything reconstructed per call.
func TestRealBlenderKeepsStateBetweenCalls(t *testing.T) {
	requireLiveBlender(t)
	fake := testutil.NewFakeOmniRoute(t, testutil.FakeStep{Content: "done"})
	rt := testRuntime(t, fake, t.TempDir())
	if err := rt.LoadMCPServers(context.Background(), []mcp.Server{blenderServer()}); err != nil {
		t.Fatalf("LoadMCPServers: %v", err)
	}
	runCode, ok := rt.Tools.Get("mcp:blender:execute_blender_code")
	if !ok {
		t.Fatal("execute_blender_code did not register")
	}
	sceneInfo, ok := rt.Tools.Get("mcp:blender:get_scene_info")
	if !ok {
		t.Fatal("get_scene_info did not register")
	}

	name := fmt.Sprintf("OmniHarnessMarker%d", time.Now().UnixNano()%100000)
	if _, err := runCode.Run(context.Background(), map[string]any{
		"code":        "import bpy\nbpy.ops.mesh.primitive_cube_add()\nbpy.context.object.name = '" + name + "'",
		"user_prompt": "add a marker cube",
	}); err != nil {
		t.Fatalf("execute_blender_code: %v", err)
	}
	res, err := sceneInfo.Run(context.Background(), map[string]any{"user_prompt": "list the objects"})
	if err != nil {
		t.Fatalf("get_scene_info: %v", err)
	}
	if !strings.Contains(res.Output, name) {
		t.Fatalf("the object created by the previous call is gone; output was:\n%s", truncateForLog(res.Output))
	}
	// A real startup scene has a camera alongside whatever we added.
	if !strings.Contains(res.Output, "Camera") {
		t.Errorf("scene info has no camera, so this is not a real Blender scene:\n%s", truncateForLog(res.Output))
	}

	// Clean up so repeated runs do not accumulate objects.
	if _, err := runCode.Run(context.Background(), map[string]any{
		"code":        "import bpy\no = bpy.data.objects.get('" + name + "')\nif o: bpy.data.objects.remove(o, do_unlink=True)",
		"user_prompt": "remove the marker cube",
	}); err != nil {
		t.Logf("cleanup failed: %v", err)
	}
}

// A tool that cannot work in this Blender must fail as a tool failure, not as
// a dead provider: the server is fine, the operation is not.
func TestRealBlenderReportsToolFailureNotUnavailable(t *testing.T) {
	requireLiveBlender(t)
	fake := testutil.NewFakeOmniRoute(t, testutil.FakeStep{Content: "done"})
	rt := testRuntime(t, fake, t.TempDir())
	srv := blenderServer()
	srv.ToolCapabilities["get_viewport_screenshot"] = []string{"render_scene"}
	if err := rt.LoadMCPServers(context.Background(), []mcp.Server{srv}); err != nil {
		t.Fatalf("LoadMCPServers: %v", err)
	}
	shot, ok := rt.Tools.Get("mcp:blender:get_viewport_screenshot")
	if !ok {
		t.Fatal("get_viewport_screenshot did not register")
	}
	// Headless Blender has no viewport, so this fails. Under a GUI it
	// succeeds and returns an image block, which is equally fine here: what
	// must never happen is the provider being reported as gone.
	res, err := shot.Run(context.Background(), map[string]any{"max_size": 400, "user_prompt": "look"})
	if err != nil {
		if got := tools.KindOf(err); got != tools.ErrFailed {
			t.Errorf("kind = %s, want %s: the server is alive, only the operation failed", got, tools.ErrFailed)
		}
		if !strings.Contains(strings.ToLower(err.Error()), "screenshot") {
			t.Errorf("error %q does not say what failed", err)
		}
		return
	}
	if len(res.Images) != 1 {
		t.Errorf("a successful screenshot returned %d images, want 1", len(res.Images))
	}
	t.Logf("viewport screenshot succeeded: %+v", res.Images)
}

func truncateForLog(s string) string {
	if len(s) > 600 {
		return s[:600] + "…"
	}
	return s
}

// The whole line of work, end to end, against the real thing: Blender renders,
// the screenshot comes back as an MCP image block, the adapter decodes it to
// disk, and the agent attaches it to a model request as content parts. The
// model itself is the fake — a live one needs OmniRoute — but everything
// between Blender and the wire is real.
func TestRealBlenderScreenshotReachesTheModel(t *testing.T) {
	requireLiveBlender(t)
	workspace := t.TempDir()

	fake := testutil.NewFakeOmniRoute(t,
		testutil.FakeStep{ToolCalls: []gateway.ToolCall{
			blenderCall("c1", "mcp:blender:get_viewport_screenshot",
				map[string]any{"max_size": 400, "user_prompt": "look at the viewport"})}},
		testutil.FakeStep{Content: "The cube is centred and lit from the left."},
	)
	testutil.InitFakeWorkspace(t, workspace)
	cfg := config.Default()
	cfg.Persistence.Dir = workspace
	cfg.Policy.WorkspaceRoot = workspace
	cfg.Models.Capabilities = nil
	cfg.Models.Default = "fake/coding-model"
	cfg.Models.Supports = map[string][]string{"fake/vision-model": {"vision"}}
	rt, err := New(cfg, Options{Gateway: fake.Client()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(rt.Close)

	srv := blenderServer()
	srv.ToolCapabilities["get_viewport_screenshot"] = []string{"inspect_3d_scene", "render_scene"}
	if err := rt.LoadMCPServers(context.Background(), []mcp.Server{srv}); err != nil {
		t.Fatalf("LoadMCPServers: %v", err)
	}

	ss, err := rt.NewSession(workspace, "blender vision")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := rt.RunTask(context.Background(), ss.ID,
		"Look at the Blender viewport and describe the composition.",
		RunOptions{ApproveAll: true}); err != nil {
		t.Fatalf("RunTask: %v", err)
	}

	// Blender's own pixels are on disk.
	shots, err := filepath.Glob(filepath.Join(workspace, ".omniharness", "artifacts", "*.png"))
	if err != nil {
		t.Fatal(err)
	}
	if len(shots) != 1 {
		t.Fatalf("saved %d screenshots from Blender, want 1", len(shots))
	}
	raw, err := os.ReadFile(shots[0])
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) < 8 || string(raw[1:4]) != "PNG" {
		t.Fatal("the saved artifact is not a PNG")
	}

	// And they reached a model call, on a model declared able to see them.
	var visionRequests int
	for _, req := range fake.RequestsSnapshot() {
		for _, m := range req.Messages {
			if m.Role == "user" && strings.Contains(m.Content, "[image]") {
				if req.Model != "fake/vision-model" {
					t.Errorf("the image went to %q, which is not declared vision-capable", req.Model)
				}
				visionRequests++
			}
		}
	}
	if visionRequests != 1 {
		t.Fatalf("%d requests carried Blender's screenshot, want 1", visionRequests)
	}
	t.Logf("Blender screenshot: %d bytes on disk, attached to one vision request", len(raw))
}
