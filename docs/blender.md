# Driving Blender from OmniHarness

Blender reaches the harness as an ordinary MCP tool provider, through
[blender-mcp](https://github.com/ahujasid/blender-mcp). The harness contains no
Blender-specific code — this page is configuration and setup, not a feature.

Verified against Blender 5.2.1 LTS, blender-mcp 1.9.1 (server 1.29.1, 28 tools).

## The pieces

```
OmniHarness ──stdio JSON-RPC──> blender-mcp ──TCP 9876──> Blender addon ──> bpy
```

`blender-mcp` is the MCP server. It does not contain Blender; it forwards to a
socket opened by an addon running *inside* Blender. Both have to be up.

## Running Blender headless

blender-mcp's documentation says the addon needs Blender's GUI. That is because
the addon's socket thread must not touch `bpy`, so it queues commands and drains
them on the main thread through `bpy.app.timers` — and timers never fire under
`--background`. `start()` checks `bpy.app.background` and declines, printing
"commands would never execute".

That premise stops holding if something else drains the queue. Under
`--background` the `--python` script *is* the main thread, so it can call
`_drain_command_queue()` in a loop and queued commands execute on exactly the
thread the timer would have used. `scripts/blender_headless.py` does that:

```bash
# Extract the bundled addon once (it ships inside the blender-mcp wheel).
python scripts/extract_blender_addon.py /tmp/blender_mcp_addon.py

BLENDER_MCP_ADDON=/tmp/blender_mcp_addon.py \
  blender --background --python scripts/blender_headless.py
```

Leave that running. It prints `BOOTSTRAP: server listening on 127.0.0.1:9876`.

The script shadows `bpy.app.background` for the duration of `start()` only, and
restores it immediately; nothing else about the addon's behaviour changes.

Running Blender with its GUI works too, and needs none of this — enable the
addon and press *Start Server* in the sidebar. Use the GUI when you want a
person watching the viewport change.

### What works headless

Everything that does not need a window. Scene inspection, `execute_blender_code`,
and `bpy.ops.render.render(write_still=True)` all work — a headless render is
Blender's own main use case. `get_viewport_screenshot` also works in practice on
5.2.1, but it drives a UI operator, so treat it as best-effort headless and use
the GUI if you depend on it.

## Configuration

```toml
[[mcp.servers]]
name = "blender"
command = "uvx"
args = ["blender-mcp"]
capabilities = ["execute_code"]

[mcp.servers.tool_capabilities]
get_scene_info                  = ["inspect_3d_scene"]
get_object_info                 = ["inspect_3d_scene"]
get_viewport_screenshot         = ["inspect_3d_scene", "render_scene"]
execute_blender_code            = ["modify_3d_scene", "execute_code"]
set_texture                     = ["modify_3d_scene"]
generate_hyper3d_model_via_text = ["generate_3d_asset"]
```

Declare capabilities **per tool**. blender-mcp exposes 28, spanning scene
inspection, rendering, telemetry and third-party asset search; a single
server-level list gives every one of them every capability, so "what can render
a scene?" answers "all 28".

To let a model actually look at a screenshot, declare a vision-capable model:

```toml
[models]
vision = ["openai/gpt-5"]
```

Without it the agent is told in text that an image exists which it cannot view.
See `docs/architecture.md` §5a.

Check it loaded:

```bash
omniharness plugins
```

## Permissions

`execute_blender_code` runs arbitrary Python inside Blender. Every MCP tool is
classified high risk, so the default `[policy] risk_action` of `high = "ask"`
prompts before each call. Do not turn that off for a Blender server: arbitrary
`bpy` includes arbitrary `os`.

## Tests

Two opt-in suites, both skipped by default so the rest stays hermetic and
offline:

```bash
# Real blender-mcp server. No Blender needed — it answers initialize and
# tools/list without one, and reports the missing connection at call time.
OMNIHARNESS_LIVE_MCP=1 go test ./internal/runtime -run RealMCPServer

# Real Blender. Needs the addon listening on 127.0.0.1:9876 (see above).
OMNIHARNESS_LIVE_BLENDER=1 go test ./internal/runtime -run Blender
```

The Blender suite renders an image, confirms scene state survives between
calls, and checks that a screenshot reaches a model request as content parts.
