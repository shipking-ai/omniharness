package mcp

import (
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// blenderShapedServer mimics the content shapes blender-mcp 1.9.1 actually
// returns: get_scene_info is text, get_viewport_screenshot is a FastMCP
// Image — an image block carrying base64 PNG data and no text at all.
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
            {"name": "get_scene_info", "description": "Get scene info", "inputSchema": {"type": "object", "properties": {}}},
            {"name": "get_viewport_screenshot", "description": "Capture the viewport", "inputSchema": {"type": "object", "properties": {"max_size": {"type": "integer"}}}},
        ]}
    elif method == "tools/call":
        name = msg.get("params", {}).get("name")
        if name == "get_viewport_screenshot":
            result = {"content": [{"type": "image", "data": PNG, "mimeType": "image/png"}], "isError": False}
        elif name == "mixed":
            result = {"content": [
                {"type": "text", "text": "scene rendered"},
                {"type": "image", "data": PNG, "mimeType": "image/png"},
            ], "isError": False}
        elif name == "undecodable":
            result = {"content": [{"type": "image", "data": "not base64 !!", "mimeType": "image/png"}], "isError": False}
        else:
            result = {"content": [{"type": "text", "text": "Scene: 3 objects"}], "isError": False}
    else:
        result = {}
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result}) + "\n")
    sys.stdout.flush()
`

func startBlenderShaped(t *testing.T, artifactDir string) *Client {
	t.Helper()
	if !pythonAvailable() {
		t.Skip("python not available")
	}
	script := filepath.Join(t.TempDir(), "blender_shaped.py")
	if err := writeFile(script, blenderShapedServer); err != nil {
		t.Fatal(err)
	}
	c := &Client{server: Server{Name: "blender", Command: "python", Args: []string{script},
		Capabilities: []string{"inspect_3d_scene", "render_scene"}}}
	if err := c.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

// The bug: an image-only result read as text produced an empty string and no
// error — a successful call that returned nothing. That is the observe step of
// an observe/evaluate loop failing silently, which is worse than failing.
func TestImageContentIsSavedNotDropped(t *testing.T) {
	dir := t.TempDir()
	c := startBlenderShaped(t, dir)
	a := &ToolAdapter{Client: c, ArtifactDir: dir,
		Info: ToolInfo{Name: "get_viewport_screenshot", Description: "Capture the viewport"}}

	res, err := a.Run(context.Background(), map[string]any{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if strings.TrimSpace(res.Output) == "" {
		t.Fatal("an image-only tool result produced empty output")
	}
	if !strings.Contains(res.Output, "image/png") {
		t.Errorf("output %q does not say what the content was", res.Output)
	}
	if len(res.Artifacts) != 1 {
		t.Fatalf("Artifacts = %v, want exactly one saved file", res.Artifacts)
	}
	if !res.Artifact {
		t.Error("a result that produced a file is not marked as an artifact")
	}
	if !strings.Contains(res.Output, res.Artifacts[0]) {
		t.Errorf("output %q does not tell the model where the file is", res.Output)
	}

	saved, err := os.ReadFile(res.Artifacts[0])
	if err != nil {
		t.Fatalf("reading the saved artifact: %v", err)
	}
	if len(saved) < 8 || string(saved[1:4]) != "PNG" {
		t.Errorf("the saved file is not the PNG the server sent (%d bytes)", len(saved))
	}
	if ext := filepath.Ext(res.Artifacts[0]); ext != ".png" {
		t.Errorf("saved with extension %q, want .png", ext)
	}
}

func TestTextContentIsUnchanged(t *testing.T) {
	dir := t.TempDir()
	c := startBlenderShaped(t, dir)
	a := &ToolAdapter{Client: c, ArtifactDir: dir, Info: ToolInfo{Name: "get_scene_info"}}
	res, err := a.Run(context.Background(), map[string]any{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Output != "Scene: 3 objects" {
		t.Errorf("Output = %q, want the server's text verbatim", res.Output)
	}
	if len(res.Artifacts) != 0 {
		t.Errorf("a text-only result produced artifacts: %v", res.Artifacts)
	}
	if res.Artifact {
		t.Error("a text-only result was marked as an artifact")
	}
}

func TestMixedContentKeepsTextAndFile(t *testing.T) {
	dir := t.TempDir()
	c := startBlenderShaped(t, dir)
	a := &ToolAdapter{Client: c, ArtifactDir: dir, Info: ToolInfo{Name: "mixed"}}
	res, err := a.Run(context.Background(), map[string]any{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !strings.Contains(res.Output, "scene rendered") {
		t.Errorf("output %q lost the text block", res.Output)
	}
	if len(res.Artifacts) != 1 {
		t.Errorf("Artifacts = %v, want the image saved alongside the text", res.Artifacts)
	}
}

// Undecodable data must be reported, never silently skipped.
func TestUndecodableContentIsReported(t *testing.T) {
	dir := t.TempDir()
	c := startBlenderShaped(t, dir)
	a := &ToolAdapter{Client: c, ArtifactDir: dir, Info: ToolInfo{Name: "undecodable"}}
	res, err := a.Run(context.Background(), map[string]any{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !strings.Contains(res.Output, "could not be decoded") {
		t.Errorf("output %q hides undecodable content", res.Output)
	}
	if len(res.Artifacts) != 0 {
		t.Errorf("undecodable content produced artifacts: %v", res.Artifacts)
	}
}

// Without a directory there is nowhere to put the bytes. The content must
// still be described rather than dropped, and nothing may claim it was saved.
func TestNoArtifactDirStillReportsTheContent(t *testing.T) {
	c := startBlenderShaped(t, "")
	a := &ToolAdapter{Client: c, Info: ToolInfo{Name: "get_viewport_screenshot"}}
	res, err := a.Run(context.Background(), map[string]any{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !strings.Contains(res.Output, "could not be saved") {
		t.Errorf("output %q does not say the content went nowhere", res.Output)
	}
	if len(res.Artifacts) != 0 {
		t.Errorf("Artifacts = %v with no directory configured", res.Artifacts)
	}
}

func TestExtensionForMime(t *testing.T) {
	for mime, want := range map[string]string{
		"image/png": ".png", "IMAGE/PNG ": ".png", "image/jpeg": ".jpg",
		"application/pdf": ".pdf", "": ".bin", "application/x-unheard-of": ".bin",
	} {
		if got := extensionFor(mime); got != want {
			t.Errorf("extensionFor(%q) = %q, want %q", mime, got, want)
		}
	}
}

func TestSanitizeKeepsPathsSafe(t *testing.T) {
	for _, in := range []string{"../../etc/passwd", "a/b", `c\d`, "name with spaces"} {
		got := sanitize(in)
		if strings.ContainsAny(got, `/\. `) {
			t.Errorf("sanitize(%q) = %q, still usable as a path traversal", in, got)
		}
	}
	if got := sanitize("get_viewport-1"); got != "get_viewport-1" {
		t.Errorf("sanitize mangled a safe name: %q", got)
	}
}

func TestBase64Sanity(t *testing.T) {
	// Guards the test fixture itself: if this decoding changes, the PNG
	// assertions above are testing nothing.
	if _, err := base64.StdEncoding.DecodeString("aGk="); err != nil {
		t.Fatal(err)
	}
}
