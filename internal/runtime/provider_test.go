package runtime

import (
	"context"
	"os"
	"os/exec"
	"testing"
	"time"

	"omniharness/internal/event"
	"omniharness/internal/mcp"
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
