package runtime

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"time"

	"omniharness/internal/mcp"
	"omniharness/internal/testutil"
	"omniharness/internal/tools"
)

// Runs the published obs-mcp server. Opt in with OMNIHARNESS_LIVE_MCP=1.
//
// OBS Studio itself is NOT required here and NOT driven. Like blender-mcp and
// resolve-mcp, the server answers initialize and tools/list without the
// application; that pins registration, per-tool capability routing, real
// schemas and effect gating against a 125-tool surface. Actually controlling
// OBS additionally needs OBS running with its WebSocket server enabled
// (Tools → WebSocket Server Settings), which is off by default.
func obsCommand() (string, []string) {
	if runtime.GOOS == "windows" {
		return "npx.cmd", []string{"-y", "obs-mcp@latest"}
	}
	return "npx", []string{"-y", "obs-mcp@latest"}
}

func obsServer() mcp.Server {
	cmd, args := obsCommand()
	return mcp.Server{
		Name: "obs", Command: cmd, Args: args,
		Capabilities: []string{"control_obs"},
		ToolCapabilities: map[string][]string{
			"obs-get-scene-list":        {"inspect_scene"},
			"obs-get-current-scene":     {"inspect_scene"},
			"obs-set-current-scene":     {"switch_scene"},
			"obs-get-source-screenshot": {"capture_screen"},
			"obs-start-record":          {"record_video"},
			"obs-stop-record":           {"record_video"},
			"obs-start-stream":          {"broadcast_stream"},
			"obs-remove-scene":          {"switch_scene"},
		},
		ToolEffects: map[string][]string{
			"obs-get-scene-list":        {"read_only"},
			"obs-get-current-scene":     {"read_only"},
			"obs-get-source-screenshot": {"read_only"},
			// Removing a scene cannot be undone from here.
			"obs-remove-scene": {"destructive"},
			"obs-remove-input": {"destructive"},
			// Going live is public and irreversible in the sense that matters:
			// once it is out, it is out.
			"obs-start-stream": {"external", "requires_confirmation"},
		},
	}
}

func TestRealOBSServerRegistersAndGates(t *testing.T) {
	if os.Getenv("OMNIHARNESS_LIVE_MCP") != "1" {
		t.Skip("set OMNIHARNESS_LIVE_MCP=1 to run against a real MCP server")
	}
	cmd, _ := obsCommand()
	if _, err := exec.LookPath(cmd); err != nil {
		t.Skipf("%s not available", cmd)
	}

	fake := testutil.NewFakeOmniRoute(t, testutil.FakeStep{Content: "done"})
	rt := testRuntime(t, fake, t.TempDir())
	if err := rt.LoadMCPServers(context.Background(), []mcp.Server{obsServer()}); err != nil {
		t.Fatalf("LoadMCPServers: %v", err)
	}

	registered := rt.Tools.WithProvider("mcp:obs")
	if len(registered) < 50 {
		t.Fatalf("registered %d tools from obs-mcp, want its full surface", len(registered))
	}
	if !strings.Contains(registered[0].Version, "obs-mcp") {
		t.Errorf("Version = %q, want the server's reported name and version", registered[0].Version)
	}

	// Per-tool routing: screen capture is one tool, not all 125.
	if got := rt.Tools.WithCapability("capture_screen"); len(got) != 1 ||
		got[0].Name != "mcp:obs:obs-get-source-screenshot" {
		t.Errorf("WithCapability(capture_screen) = %v, want only the screenshot tool", specNames(got))
	}
	if got := rt.Tools.WithCapability("record_video"); len(got) != 2 {
		t.Errorf("WithCapability(record_video) = %v, want start and stop", specNames(got))
	}

	// Going live must never happen without someone saying so.
	stream, ok := rt.Tools.Get("mcp:obs:obs-start-stream")
	if !ok {
		t.Fatal("obs-start-stream did not register")
	}
	if !stream.Spec().HasEffect(tools.EffectRequiresConfirmation) {
		t.Error("obs-start-stream is not gated; starting a public broadcast must be confirmed")
	}
	remove, ok := rt.Tools.Get("mcp:obs:obs-remove-scene")
	if !ok {
		t.Fatal("obs-remove-scene did not register")
	}
	if len(remove.Spec().GatedEffects()) == 0 {
		t.Error("removing a scene produces no gated effects, so policy would not prompt")
	}
	// Reading the scene list is not a decision anyone needs to approve.
	list, _ := rt.Tools.Get("mcp:obs:obs-get-scene-list")
	if len(list.Spec().GatedEffects()) != 0 {
		t.Error("listing scenes is gated; reading should not need approval")
	}

	// Real schemas are enforced before anything reaches OBS.
	setScene, ok := rt.Tools.Get("mcp:obs:obs-set-current-scene")
	if !ok {
		t.Fatal("obs-set-current-scene did not register")
	}
	if err := tools.ValidateInput(setScene.Spec(), map[string]any{}); err == nil {
		t.Error("a scene switch with no scene name was accepted")
	} else if !strings.Contains(err.Error(), "sceneName") {
		t.Errorf("rejection %q does not name the missing argument", err)
	}
}

// Drives a real OBS. Needs OBS running with its WebSocket server enabled
// (Tools -> WebSocket Server Settings) and OBS_WEBSOCKET_PASSWORD exported if
// authentication is on. Opt in with OMNIHARNESS_LIVE_OBS=1.
//
// Everything it touches it creates and removes: a scene named for this test,
// never an existing one.
func requireLiveOBS(t *testing.T) {
	t.Helper()
	if os.Getenv("OMNIHARNESS_LIVE_OBS") != "1" {
		t.Skip("set OMNIHARNESS_LIVE_OBS=1 with OBS running and its WebSocket server enabled")
	}
	cmd, _ := obsCommand()
	if _, err := exec.LookPath(cmd); err != nil {
		t.Skipf("%s not available", cmd)
	}
	conn, err := net.DialTimeout("tcp", "127.0.0.1:4455", 3*time.Second)
	if err != nil {
		t.Skipf("nothing listening on the OBS WebSocket port: %v", err)
	}
	conn.Close()
}

func liveOBSServer() mcp.Server {
	s := obsServer()
	// The password reaches the child through the server's own env, which
	// survives the credential filter applied to everything else.
	if pw := os.Getenv("OBS_WEBSOCKET_PASSWORD"); pw != "" {
		s.Env = []string{"OBS_WEBSOCKET_PASSWORD=" + pw}
	}
	return s
}

func TestHarnessDrivesRealOBS(t *testing.T) {
	requireLiveOBS(t)
	workspace := t.TempDir()
	fake := testutil.NewFakeOmniRoute(t, testutil.FakeStep{Content: "done"})
	rt := testRuntime(t, fake, workspace)
	if err := rt.LoadMCPServers(context.Background(), []mcp.Server{liveOBSServer()}); err != nil {
		t.Fatalf("LoadMCPServers: %v", err)
	}
	ctx := context.Background()

	version, ok := rt.Tools.Get("mcp:obs:obs-get-version")
	if !ok {
		t.Fatal("obs-get-version did not register")
	}

	// obs-mcp answers tools/list immediately but opens its WebSocket to OBS
	// asynchronously afterwards, so the first call can arrive before the
	// identify handshake finishes and comes back "Not connected or
	// identified". That is the server's readiness, not a harness failure, and
	// it is the provider's business to be slow — so wait for it here rather
	// than teaching the tool layer to retry, which would mask real failures.
	var res tools.Result
	var err error
	deadline := time.Now().Add(30 * time.Second)
	for {
		res, err = version.Run(ctx, map[string]any{})
		if err == nil || time.Now().After(deadline) ||
			!strings.Contains(res.Output, "Not connected") {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("could not talk to OBS: %v (output: %s)", err, oneLineForLog(res.Output))
	}
	if !strings.Contains(strings.ToLower(res.Output), "obs") {
		t.Fatalf("unexpected version reply: %s", res.Output)
	}
	t.Logf("OBS says: %s", oneLineForLog(res.Output))

	// Create a scene of our own, switch to it, and confirm OBS agrees.
	scene := fmt.Sprintf("OmniHarness-%d", time.Now().UnixNano()%100000)
	create, _ := rt.Tools.Get("mcp:obs:obs-create-scene")
	if _, err := create.Run(ctx, map[string]any{"sceneName": scene}); err != nil {
		t.Fatalf("create scene: %v", err)
	}
	t.Cleanup(func() {
		if rm, ok := rt.Tools.Get("mcp:obs:obs-remove-scene"); ok {
			_, _ = rm.Run(context.Background(), map[string]any{"sceneName": scene})
		}
	})

	set, _ := rt.Tools.Get("mcp:obs:obs-set-current-scene")
	if _, err := set.Run(ctx, map[string]any{"sceneName": scene}); err != nil {
		t.Fatalf("switch scene: %v", err)
	}
	current, _ := rt.Tools.Get("mcp:obs:obs-get-current-scene")
	cur, err := current.Run(ctx, map[string]any{})
	if err != nil {
		t.Fatalf("get current scene: %v", err)
	}
	if !strings.Contains(cur.Output, scene) {
		t.Fatalf("OBS reports current scene %q, want the one just created (%s)", oneLineForLog(cur.Output), scene)
	}

	// State set by one call is still there on the next: proof this is one
	// live OBS rather than anything reconstructed per call.
	list, _ := rt.Tools.Get("mcp:obs:obs-get-scene-list")
	scenes, err := list.Run(ctx, map[string]any{})
	if err != nil {
		t.Fatalf("list scenes: %v", err)
	}
	if !strings.Contains(scenes.Output, scene) {
		t.Errorf("the created scene is missing from the scene list")
	}
}

func oneLineForLog(s string) string {
	flat := strings.Join(strings.Fields(s), " ")
	if len(flat) > 200 {
		return flat[:200] + "…"
	}
	return flat
}
