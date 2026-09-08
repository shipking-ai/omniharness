package runtime

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"omniharness/internal/gateway"
	"omniharness/internal/mcp"
	"omniharness/internal/task"
	"omniharness/internal/testutil"
	"omniharness/internal/tools"
)

// Video editing through Blender's Video Sequence Editor — a real NLE, reached
// through the provider that already works. No new integration: the same
// execute_blender_code tool that builds 3D scenes also cuts timelines, so the
// only thing that changes is which capabilities the operator declares for it.
//
// Needs Blender with the blender-mcp addon listening; see docs/blender.md.
// Opt in with OMNIHARNESS_LIVE_BLENDER=1.
func vseServer() mcp.Server {
	return mcp.Server{
		Name: "blender", Command: "uvx", Args: []string{"blender-mcp"},
		Capabilities: []string{"execute_code"},
		ToolCapabilities: map[string][]string{
			// One tool, several capabilities, because arbitrary bpy really can
			// do all of it. Declaring only "modify_3d_scene" would have hidden
			// the editor from anything looking for it.
			"execute_blender_code": {"modify_3d_scene", "edit_timeline", "edit_video", "render_video", "execute_code"},
			"get_scene_info":       {"inspect_3d_scene"},
		},
	}
}

// Build a two-strip timeline, trim one strip, and render a frame from each
// side of the trim. Frame 1 must show only the background; frame 24 must show
// the title. That difference is what proves the edit is a real time-based cut
// rather than a still with text on it.
func TestHarnessEditsVideoInBlender(t *testing.T) {
	requireLiveBlender(t)
	workspace := t.TempDir()
	early := filepath.ToSlash(filepath.Join(workspace, "frame01.png"))
	late := filepath.ToSlash(filepath.Join(workspace, "frame24.png"))

	// Blender 5.x renamed sequences -> strips and new_effect takes length
	// rather than frame_end; the getattr keeps this working either way.
	code := "import bpy\n" +
		"s = bpy.context.scene\n" +
		"se = s.sequence_editor_create()\n" +
		// hasattr, not `or`: an empty strip collection is falsy in Python, so
		// `getattr(...) or se.sequences` falls through to the name Blender 5.x
		// removed, and fails on a brand-new editor — exactly when it is used.
		"coll = se.strips if hasattr(se, 'strips') else se.sequences\n" +
		"bg = coll.new_effect(name='bg', type='COLOR', channel=1, frame_start=1, length=48)\n" +
		"bg.color = (0.10, 0.18, 0.42)\n" +
		"title = coll.new_effect(name='title', type='TEXT', channel=2, frame_start=1, length=48)\n" +
		"title.text = 'OmniHarness'\n" +
		"title.font_size = 90\n" +
		"title.frame_final_start = 12\n" +
		"s.frame_start, s.frame_end = 1, 48\n" +
		"s.render.resolution_x, s.render.resolution_y = 480, 270\n" +
		"s.render.image_settings.file_format = 'PNG'\n" +
		"s.frame_set(1)\n" +
		"s.render.filepath = '" + early + "'\n" +
		"bpy.ops.render.render(write_still=True)\n" +
		"s.frame_set(24)\n" +
		"s.render.filepath = '" + late + "'\n" +
		"bpy.ops.render.render(write_still=True)\n" +
		"print('strips:', [(x.name, x.type, x.frame_final_start) for x in coll])\n"

	fake := testutil.NewFakeOmniRoute(t,
		testutil.FakeStep{ToolCalls: []gateway.ToolCall{
			blenderCall("c1", "mcp:blender:execute_blender_code", map[string]any{
				"code": code, "user_prompt": "build and render a title sequence"})}},
		testutil.FakeStep{Content: "Built the timeline and rendered both frames."},
	)
	rt := testRuntime(t, fake, workspace)
	if err := rt.LoadMCPServers(context.Background(), []mcp.Server{vseServer()}); err != nil {
		t.Fatalf("LoadMCPServers: %v", err)
	}

	// Discovery: an editor is now findable by what it does.
	for _, capability := range []string{"edit_video", "edit_timeline", "render_video"} {
		if !rt.Tools.HasCapability(tools.Capability(capability)) {
			t.Fatalf("nothing provides %s", capability)
		}
	}

	ss, err := rt.NewSession(workspace, "vse")
	if err != nil {
		t.Fatal(err)
	}
	tsk, err := rt.RunTask(context.Background(), ss.ID,
		"Build a title sequence in the video editor and render it.", RunOptions{ApproveAll: true})
	if err != nil {
		t.Fatalf("RunTask: %v", err)
	}
	if tsk.Status != task.StatusCompleted {
		t.Fatalf("status = %s: %s", tsk.Status, tsk.Error)
	}

	a, err := os.ReadFile(filepath.FromSlash(early))
	if err != nil {
		t.Fatalf("frame 1 was not rendered: %v", err)
	}
	b, err := os.ReadFile(filepath.FromSlash(late))
	if err != nil {
		t.Fatalf("frame 24 was not rendered: %v", err)
	}
	for name, raw := range map[string][]byte{"frame 1": a, "frame 24": b} {
		if len(raw) < 8 || string(raw[1:4]) != "PNG" {
			t.Fatalf("%s is not a PNG (%d bytes)", name, len(raw))
		}
	}
	// The trim is the whole point: before it, no title; after it, a title. If
	// these matched, the strip timing did nothing.
	if len(a) == len(b) {
		t.Fatal("both frames are identical in size; the trimmed title strip had no effect")
	}
	t.Logf("frame 1 = %d bytes (background only), frame 24 = %d bytes (title visible)", len(a), len(b))
}
