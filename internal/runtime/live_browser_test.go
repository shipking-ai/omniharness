package runtime

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"omniharness/internal/mcp"
	"omniharness/internal/testutil"
	"omniharness/internal/tools"
)

// Drives a real browser through agent-browser's MCP server. Opt in with
// OMNIHARNESS_LIVE_BROWSER=1; skipped by default so the suite stays hermetic.
//
// Every page used here is a local file this test wrote. Nothing reaches a real
// site: browser automation has to respect the target's terms and access
// controls, and a test suite is not the place to be making requests to
// somebody else's server.
func requireLiveBrowser(t *testing.T) string {
	t.Helper()
	if os.Getenv("OMNIHARNESS_LIVE_BROWSER") != "1" {
		t.Skip("set OMNIHARNESS_LIVE_BROWSER=1 to run against a real browser")
	}
	path, err := exec.LookPath(browserBinaryName())
	if err != nil {
		t.Skip("agent-browser not available")
	}
	return path
}

func browserServer(bin string) mcp.Server {
	return mcp.Server{
		Name: "browser", Command: bin, Args: []string{"mcp"},
		Capabilities: []string{"browse_web"},
		ToolCapabilities: map[string][]string{
			"agent_browser_open":       {"browse_web"},
			"agent_browser_read":       {"browse_web", "inspect_page"},
			"agent_browser_snapshot":   {"inspect_page"},
			"agent_browser_get_text":   {"inspect_page"},
			"agent_browser_click":      {"interact_page"},
			"agent_browser_fill":       {"interact_page"},
			"agent_browser_screenshot": {"capture_page"},
			"agent_browser_eval":       {"execute_code"},
		},
		ToolEffects: map[string][]string{
			"agent_browser_open":       {"external"},
			"agent_browser_read":       {"external", "read_only"},
			"agent_browser_snapshot":   {"read_only"},
			"agent_browser_get_text":   {"read_only"},
			"agent_browser_screenshot": {"read_only"},
			// Arbitrary script in the page, against whatever is loaded —
			// including anything the person running this is signed in to.
			"agent_browser_eval": {"external", "requires_confirmation"},
		},
	}
}

// A second provider, of a completely different shape from the 3D one, reached
// the same way: by capability, with no browser-specific code in the harness.
func TestHarnessDrivesARealBrowser(t *testing.T) {
	bin := requireLiveBrowser(t)
	workspace := t.TempDir()
	page := filepath.Join(workspace, "page.html")
	if err := os.WriteFile(page, []byte(
		"<title>OmniHarness Probe</title><h1 id=headline>Capability routing works</h1>"), 0o644); err != nil {
		t.Fatal(err)
	}

	fake := newFakeGatewayForBrowser(t)
	rt := testRuntime(t, fake, workspace)
	if err := rt.LoadMCPServers(context.Background(), []mcp.Server{browserServer(bin)}); err != nil {
		t.Fatalf("LoadMCPServers: %v", err)
	}

	if !rt.Tools.HasCapability("browse_web") {
		t.Fatal("nothing provides browse_web")
	}
	if got := rt.Tools.WithCapability("interact_page"); len(got) != 2 {
		t.Errorf("WithCapability(interact_page) = %v, want the two interaction tools", specNames(got))
	}

	// Provenance: the server reports its own version and it must survive.
	open, ok := rt.Tools.Get("mcp:browser:agent_browser_open")
	if !ok {
		t.Fatal("agent_browser_open did not register")
	}
	if !strings.Contains(open.Spec().Version, "agent-browser") {
		t.Errorf("Version = %q, want the server's own name and version", open.Spec().Version)
	}

	// eval runs arbitrary script in whatever page is loaded, so it must be
	// gated no matter how permissive the risk table is.
	eval, ok := rt.Tools.Get("mcp:browser:agent_browser_eval")
	if !ok {
		t.Fatal("agent_browser_eval did not register")
	}
	if !eval.Spec().HasEffect(tools.EffectRequiresConfirmation) {
		t.Error("agent_browser_eval is not gated; it runs arbitrary script in a live session")
	}

	ctx := context.Background()
	if _, err := open.Run(ctx, map[string]any{"url": "file:///" + filepath.ToSlash(page)}); err != nil {
		t.Fatalf("open: %v", err)
	}
	title, ok := rt.Tools.Get("mcp:browser:agent_browser_get_title")
	if !ok {
		t.Fatal("agent_browser_get_title did not register")
	}
	res, err := title.Run(ctx, map[string]any{})
	if err != nil {
		t.Fatalf("get_title: %v", err)
	}
	if !strings.Contains(res.Output, "OmniHarness Probe") {
		t.Fatalf("the browser did not load the page; title was %q", res.Output)
	}

	text, ok := rt.Tools.Get("mcp:browser:agent_browser_get_text")
	if !ok {
		t.Fatal("agent_browser_get_text did not register")
	}
	got, err := text.Run(ctx, map[string]any{"selector": "#headline"})
	if err != nil {
		t.Fatalf("get_text: %v", err)
	}
	if !strings.Contains(got.Output, "Capability routing works") {
		t.Errorf("read %q from the page, want the headline", got.Output)
	}

	if closer, ok := rt.Tools.Get("mcp:browser:agent_browser_close"); ok {
		_, _ = closer.Run(ctx, map[string]any{})
	}
}

// A required argument the schema declares must be rejected before the call
// leaves the harness, for this provider exactly as for the 3D one.
func TestBrowserSchemaIsEnforced(t *testing.T) {
	bin := requireLiveBrowser(t)
	fake := newFakeGatewayForBrowser(t)
	rt := testRuntime(t, fake, t.TempDir())
	if err := rt.LoadMCPServers(context.Background(), []mcp.Server{browserServer(bin)}); err != nil {
		t.Fatalf("LoadMCPServers: %v", err)
	}
	click, ok := rt.Tools.Get("mcp:browser:agent_browser_click")
	if !ok {
		t.Fatal("agent_browser_click did not register")
	}
	if err := tools.ValidateInput(click.Spec(), map[string]any{}); err == nil {
		t.Error("a click with no selector was accepted")
	} else if !strings.Contains(err.Error(), "selector") {
		t.Errorf("rejection %q does not name the missing argument", err)
	}
}

func newFakeGatewayForBrowser(t *testing.T) *testutil.FakeOmniRoute {
	t.Helper()
	return testutil.NewFakeOmniRoute(t, testutil.FakeStep{Content: "done"})
}

// browserBinaryName accounts for npm shipping a .cmd shim on Windows, which
// exec.LookPath finds but os/exec cannot spawn by the bare name.
func browserBinaryName() string {
	if runtime.GOOS == "windows" {
		return "agent-browser.cmd"
	}
	return "agent-browser"
}
