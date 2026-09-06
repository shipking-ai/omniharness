package runtime

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"omniharness/internal/event"
	"omniharness/internal/gateway"
	"omniharness/internal/mcp"
	"omniharness/internal/task"
	"omniharness/internal/testutil"
)

// mcpServerScript answers initialize and tools/list, then keeps running until
// its stdin closes or it is killed.
const mcpServerScript = `
import json, sys
for line in sys.stdin:
    try:
        msg = json.loads(line)
    except Exception:
        continue
    if "id" not in msg:
        continue
    method = msg.get("method")
    if method == "initialize":
        result = {"protocolVersion": "2025-03-26", "capabilities": {"tools": {}}, "serverInfo": {"name": "fake", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": [{"name": "render", "description": "render the scene", "inputSchema": {"type": "object", "properties": {}}}]}
    else:
        result = {}
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result}) + "\n")
    sys.stdout.flush()
`

func writeScript(t *testing.T, body string) string {
	t.Helper()
	if _, err := exec.LookPath("python"); err != nil {
		t.Skip("python not available")
	}
	path := t.TempDir() + "/mcp_server.py"
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// A provider that dies mid-session must take its tools out of the registry.
// Left registered they are still offered to every model, and every call to one
// fails in a way the agent cannot interpret.
func TestDeadProviderLosesItsTools(t *testing.T) {
	script := writeScript(t, mcpServerScript)
	fake := testutil.NewFakeOmniRoute(t, testutil.FakeStep{Content: "done"})
	rt := testRuntime(t, fake, t.TempDir())

	events, cancel := rt.Bus.Subscribe(64)
	defer cancel()

	ctx := context.Background()
	if err := rt.LoadMCPServers(ctx, []mcp.Server{{
		Name: "blender", Command: "python", Args: []string{script},
		Capabilities: []string{"render_scene"},
	}}); err != nil {
		t.Fatalf("LoadMCPServers: %v", err)
	}
	if _, ok := rt.Tools.Get("mcp:blender:render"); !ok {
		t.Fatal("setup: the MCP tool did not register")
	}
	if !rt.Tools.HasCapability("render_scene") {
		t.Fatal("setup: the capability was not indexed")
	}

	// Kill the process the way a crash would.
	if len(rt.MCPClients) != 1 {
		t.Fatalf("want 1 MCP client, got %d", len(rt.MCPClients))
	}
	rt.MCPClients[0].Close()

	deadline := time.After(10 * time.Second)
	for {
		if _, ok := rt.Tools.Get("mcp:blender:render"); !ok {
			break
		}
		select {
		case <-deadline:
			t.Fatal("the dead provider's tool is still registered")
		case <-time.After(10 * time.Millisecond):
		}
	}
	if rt.Tools.HasCapability("render_scene") {
		t.Error("the capability index still advertises a dead provider")
	}
	// The native tools must survive: one provider dying is not a reason to
	// disarm the agent entirely.
	if _, ok := rt.Tools.Get("read_file"); !ok {
		t.Error("losing an MCP provider removed the native tools")
	}

	// The loss has to be visible, not silent.
	for {
		select {
		case e := <-events:
			if e.Type != event.ProviderLost {
				continue
			}
			payload, err := event.Decode(e)
			if err != nil {
				t.Fatalf("decode provider.lost: %v", err)
			}
			data, ok := payload.(*event.ProviderLostData)
			if !ok {
				t.Fatalf("provider.lost decoded to %T", payload)
			}
			if data.Provider != "mcp:blender" {
				t.Errorf("provider = %q, want mcp:blender", data.Provider)
			}
			if len(data.Tools) != 1 || data.Tools[0] != "mcp:blender:render" {
				t.Errorf("tools = %v, want [mcp:blender:render]", data.Tools)
			}
			return
		case <-time.After(10 * time.Second):
			t.Fatal("no provider.lost event was published")
		}
	}
}

// Shutdown is not a provider loss: Close must not race the watcher into
// reporting one, and must not panic when it runs the stop hooks twice.
func TestRuntimeCloseIsIdempotentWithProviders(t *testing.T) {
	script := writeScript(t, mcpServerScript)
	fake := testutil.NewFakeOmniRoute(t, testutil.FakeStep{Content: "done"})
	rt := testRuntime(t, fake, t.TempDir())
	if err := rt.LoadMCPServers(context.Background(), []mcp.Server{{
		Name: "blender", Command: "python", Args: []string{script},
	}}); err != nil {
		t.Fatalf("LoadMCPServers: %v", err)
	}
	rt.Close()
	rt.Close() // t.Cleanup will call it a third time.
}

// blenderShapedServer mirrors the content shapes blender-mcp 1.9.1 returns:
// get_scene_info is text, get_viewport_screenshot is an image block with no
// text at all. Tool names and shapes were read from the published package;
// nothing here claims Blender itself was driven.
const blenderShapedServer = `
import base64, json, sys
PNG = base64.b64encode(bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
    "890000000a49444154789c6360000002000100ffff0000060005a54f9d000000"
    "0049454e44ae426082")).decode()
for line in sys.stdin:
    try:
        msg = json.loads(line)
    except Exception:
        continue
    if "id" not in msg:
        continue
    method = msg.get("method")
    if method == "initialize":
        result = {"protocolVersion": "2025-03-26", "capabilities": {"tools": {}}, "serverInfo": {"name": "blender", "version": "1.9.1"}}
    elif method == "tools/list":
        result = {"tools": [
            {"name": "get_scene_info", "description": "Get scene info",
             "inputSchema": {"type": "object", "properties": {}}},
            {"name": "get_viewport_screenshot", "description": "Capture the viewport",
             "inputSchema": {"type": "object", "properties": {"max_size": {"type": "integer"}}, "required": ["max_size"], "additionalProperties": False}},
        ]}
    elif method == "tools/call":
        if msg["params"]["name"] == "get_viewport_screenshot":
            result = {"content": [{"type": "image", "data": PNG, "mimeType": "image/png"}], "isError": False}
        else:
            result = {"content": [{"type": "text", "text": "Scene: 3 objects"}], "isError": False}
    else:
        result = {}
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result}) + "\n")
    sys.stdout.flush()
`

func toolCall(id, name, args string) gateway.ToolCall {
	var tc gateway.ToolCall
	tc.ID = id
	tc.Type = "function"
	tc.Function.Name = name
	tc.Function.Arguments = args
	return tc
}

// The whole point of the capability work: a provider this build has never
// heard of becomes usable through configuration alone. This drives one end to
// end — capability routing, schema validation, policy, execution, and an
// image observation landing on disk — with no Blender-specific code anywhere
// in the harness.
func TestExternalProviderRunsEndToEnd(t *testing.T) {
	script := writeScript(t, blenderShapedServer)
	workspace := t.TempDir()

	fake := testutil.NewFakeOmniRoute(t,
		// 1. A call the schema rejects: max_size is required.
		testutil.FakeStep{ToolCalls: []gateway.ToolCall{
			toolCall("c1", "mcp:blender:get_viewport_screenshot", `{}`)}},
		// 2. Corrected, and it renders.
		testutil.FakeStep{ToolCalls: []gateway.ToolCall{
			toolCall("c2", "mcp:blender:get_viewport_screenshot", `{"max_size":800}`)}},
		// 3. Done.
		testutil.FakeStep{Content: "Captured the viewport."},
	)
	rt := testRuntime(t, fake, workspace)

	if err := rt.LoadMCPServers(context.Background(), []mcp.Server{{
		Name: "blender", Command: "python", Args: []string{script},
		Capabilities: []string{"inspect_3d_scene", "render_scene"},
	}}); err != nil {
		t.Fatalf("LoadMCPServers: %v", err)
	}

	// Discovery: the harness knows what the provider can do without knowing
	// what it is.
	if !rt.Tools.HasCapability("render_scene") {
		t.Fatal("the provider's capability was not indexed")
	}
	if got := rt.Tools.WithCapability("render_scene"); len(got) != 2 {
		t.Fatalf("WithCapability(render_scene) = %d tools, want both of the server's", len(got))
	}

	ss, err := rt.NewSession(workspace, "blender")
	if err != nil {
		t.Fatal(err)
	}
	tsk, err := rt.RunTask(context.Background(), ss.ID, "Capture the current viewport.", RunOptions{ApproveAll: true})
	if err != nil {
		t.Fatalf("RunTask: %v", err)
	}
	if tsk.Status != task.StatusCompleted {
		t.Fatalf("status = %s: %s", tsk.Status, tsk.Error)
	}

	// The screenshot must have reached disk. Before non-text content was
	// handled, this call returned an empty string and nothing was written.
	artifacts, err := filepath.Glob(filepath.Join(workspace, ".omniharness", "artifacts", "*.png"))
	if err != nil {
		t.Fatal(err)
	}
	if len(artifacts) != 1 {
		t.Fatalf("saved %d png artifacts, want 1: %v", len(artifacts), artifacts)
	}
	raw, err := os.ReadFile(artifacts[0])
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) < 8 || string(raw[1:4]) != "PNG" {
		t.Error("the saved artifact is not the image the provider returned")
	}

	// The rejected call must have been recorded as a failure with the reason,
	// and must never have reached the server.
	calls, err := rt.Store.ToolCalls(ss.ID)
	if err != nil {
		t.Fatal(err)
	}
	var invalid, ok int
	for _, c := range calls {
		if c.Tool != "mcp:blender:get_viewport_screenshot" {
			continue
		}
		switch c.Status {
		case "failed":
			invalid++
			if !strings.Contains(c.Error, "max_size") {
				t.Errorf("the recorded failure %q does not name the missing argument", c.Error)
			}
		case "completed":
			ok++
		}
	}
	if invalid != 1 {
		t.Errorf("recorded %d invalid calls, want 1", invalid)
	}
	if ok != 1 {
		t.Errorf("recorded %d successful calls, want 1", ok)
	}
}
