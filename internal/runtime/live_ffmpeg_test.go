package runtime

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"omniharness/internal/config"
	"omniharness/internal/testutil"
)

// ffmpeg reached as a declared command rather than through MCP. This is the
// point of the command adapter: a program with a stable CLI needs no server,
// and the harness needs no knowledge of what ffmpeg is.
//
// Opt in with OMNIHARNESS_LIVE_FFMPEG=1.
func requireFFmpeg(t *testing.T) {
	t.Helper()
	if os.Getenv("OMNIHARNESS_LIVE_FFMPEG") != "1" {
		t.Skip("set OMNIHARNESS_LIVE_FFMPEG=1 to run against a real ffmpeg")
	}
	for _, bin := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Skipf("%s not on PATH", bin)
		}
	}
}

func ffmpegConfig(workspace string) config.Config {
	cfg := config.Default()
	cfg.Persistence.Dir = workspace
	cfg.Policy.WorkspaceRoot = workspace
	cfg.Commands = []config.Command{
		{
			Name: "ffmpeg", Description: "Encode, transcode or trim audio and video.",
			Command: "ffmpeg", ArgsParam: "args",
			Capabilities: []string{"transcode_video", "render_video"},
			// It writes files and reaches nothing off this machine, but an
			// overwrite is not recoverable, so it is declared destructive and
			// therefore always prompts.
			Effects: []string{"destructive"},
		},
		{
			Name: "ffprobe", Description: "Report the streams and format of a media file.",
			Command: "ffprobe", ArgsParam: "args",
			Capabilities: []string{"probe_media", "inspect_media"},
			Effects:      []string{"read_only"},
			Risk:         "low",
		},
	}
	return cfg
}

// Generate a real video with ffmpeg, then read it back with ffprobe and check
// the reported dimensions and duration. A file existing proves little; a
// decoder agreeing about its contents proves it is a video.
func TestHarnessDrivesFFmpeg(t *testing.T) {
	requireFFmpeg(t)
	workspace := t.TempDir()
	out := filepath.Join(workspace, "clip.mp4")

	fake := testutil.NewFakeOmniRoute(t, testutil.FakeStep{Content: "done"})
	testutil.InitFakeWorkspace(t, workspace)
	rt, err := New(ffmpegConfig(workspace), Options{Gateway: fake.Client()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(rt.Close)
	if len(rt.CommandIssues) > 0 {
		t.Fatalf("commands did not register: %v", rt.CommandIssues)
	}

	// Discovery by capability, with no mention of ffmpeg anywhere in core.
	if got := rt.Tools.WithCapability("transcode_video"); len(got) != 1 || got[0].Name != "ffmpeg" {
		t.Fatalf("WithCapability(transcode_video) = %v, want [ffmpeg]", specNames(got))
	}
	if got := rt.Tools.WithCapability("probe_media"); len(got) != 1 || got[0].Name != "ffprobe" {
		t.Fatalf("WithCapability(probe_media) = %v, want [ffprobe]", specNames(got))
	}

	ffmpeg, _ := rt.Tools.Get("ffmpeg")
	ffprobe, _ := rt.Tools.Get("ffprobe")

	// An overwrite cannot be undone, so ffmpeg must prompt whatever the risk
	// table says; ffprobe only reads and must not.
	if len(ffmpeg.Spec().GatedEffects()) == 0 {
		t.Error("ffmpeg produces no gated effects, so a destructive overwrite would not prompt")
	}
	if len(ffprobe.Spec().GatedEffects()) != 0 {
		t.Error("ffprobe is gated; reading a file should not need approval")
	}

	res, err := ffmpeg.Run(context.Background(), map[string]any{"args": []any{
		"-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=24:duration=2",
		"-pix_fmt", "yuv420p", out,
	}})
	if err != nil {
		t.Fatalf("ffmpeg: %v\n%s", err, res.Output)
	}
	info, err := os.Stat(out)
	if err != nil {
		t.Fatalf("ffmpeg wrote no file: %v", err)
	}

	probe, err := ffprobe.Run(context.Background(), map[string]any{"args": []any{
		"-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", out,
	}})
	if err != nil {
		t.Fatalf("ffprobe: %v\n%s", err, probe.Output)
	}
	var parsed struct {
		Streams []struct {
			CodecType string `json:"codec_type"`
			Width     int    `json:"width"`
			Height    int    `json:"height"`
		} `json:"streams"`
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
	}
	if err := json.Unmarshal([]byte(probe.Output), &parsed); err != nil {
		t.Fatalf("ffprobe output is not the JSON it was asked for: %v\n%s", err, probe.Output)
	}
	if len(parsed.Streams) == 0 {
		t.Fatal("the produced file has no streams; it is not a video")
	}
	s := parsed.Streams[0]
	if s.CodecType != "video" || s.Width != 320 || s.Height != 240 {
		t.Errorf("stream = %+v, want a 320x240 video stream", s)
	}
	if !strings.HasPrefix(parsed.Format.Duration, "2.") {
		t.Errorf("duration = %q, want about 2 seconds", parsed.Format.Duration)
	}
	t.Logf("ffmpeg produced %d bytes, ffprobe reports %dx%d %ss",
		info.Size(), s.Width, s.Height, parsed.Format.Duration)
}

// A configured program that is not installed must be reported as absent, not
// registered and left to fail on first use.
func TestMissingCommandIsReportedNotRegistered(t *testing.T) {
	workspace := t.TempDir()
	testutil.InitFakeWorkspace(t, workspace)
	fake := testutil.NewFakeOmniRoute(t, testutil.FakeStep{Content: "done"})
	cfg := config.Default()
	cfg.Persistence.Dir = workspace
	cfg.Policy.WorkspaceRoot = workspace
	cfg.Commands = []config.Command{{
		Name: "ghost", Description: "not installed anywhere",
		Command: "definitely-not-a-real-binary-xyz", ArgsParam: "args",
		Capabilities: []string{"transcode_video"},
	}}
	rt, err := New(cfg, Options{Gateway: fake.Client()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(rt.Close)

	if _, ok := rt.Tools.Get("ghost"); ok {
		t.Error("a missing program was registered as a usable tool")
	}
	if rt.Tools.HasCapability("transcode_video") {
		t.Error("a capability is advertised by a program that is not installed")
	}
	if len(rt.CommandIssues) != 1 || !strings.Contains(rt.CommandIssues[0], "ghost") {
		t.Errorf("CommandIssues = %v, want one entry naming ghost", rt.CommandIssues)
	}
}

// A typo in the declaration must fail at startup: an unknown capability makes
// a tool unreachable and an unknown effect silently drops its gate.
func TestBadCommandDeclarationFailsStartup(t *testing.T) {
	workspace := t.TempDir()
	testutil.InitFakeWorkspace(t, workspace)
	fake := testutil.NewFakeOmniRoute(t, testutil.FakeStep{Content: "done"})
	base := func() config.Config {
		c := config.Default()
		c.Persistence.Dir = workspace
		c.Policy.WorkspaceRoot = workspace
		return c
	}
	cfg := base()
	cfg.Commands = []config.Command{{
		Name: "x", Description: "d", Command: "go", Effects: []string{"financail"},
	}}
	if _, err := New(cfg, Options{Gateway: fake.Client()}); err == nil {
		t.Error("a misspelled effect was accepted at startup")
	}
	cfg = base()
	cfg.Commands = []config.Command{{
		Name: "x", Description: "d", Command: "go", Capabilities: []string{"Bad Name"},
	}}
	if _, err := New(cfg, Options{Gateway: fake.Client()}); err == nil {
		t.Error("a malformed capability was accepted at startup")
	}
}
