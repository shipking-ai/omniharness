"""Run blender-mcp's addon server inside headless Blender.

The addon defers every bpy call from its socket thread to Blender's main
thread through bpy.app.timers, and declines to start under --background
because timers never fire there, so "commands would never execute". That
premise is what this script removes: in background mode this script IS the
main thread, so it calls the same drain function in a loop and queued commands
execute on the main thread exactly as the timer would have run them.

The check reads bpy.app.background at call time, so the addon module's view of
bpy is shadowed for the duration of start() only. Everything else delegates to
the real bpy, and the real value is restored immediately afterwards. Nothing
about the addon's behaviour changes beyond where the drain call comes from.
"""
import os
import sys
import time

import bpy


class _AppProxy:
    """Real bpy.app, except background reads False."""

    def __init__(self, real):
        self._real = real

    def __getattr__(self, name):
        if name == "background":
            return False
        return getattr(self._real, name)


class _BpyProxy:
    def __init__(self, real):
        self._real = real
        self.app = _AppProxy(real.app)

    def __getattr__(self, name):
        return getattr(self._real, name)


addon_py = os.environ["BLENDER_MCP_ADDON"]
module = os.path.splitext(os.path.basename(addon_py))[0]

bpy.ops.preferences.addon_install(filepath=addon_py, overwrite=True)
bpy.ops.preferences.addon_enable(module=module)
mod = sys.modules[module]
print("BOOTSTRAP: addon enabled:", module, flush=True)

server = mod.BlenderMCPServer(host="127.0.0.1", port=9876)

real_bpy = mod.bpy
mod.bpy = _BpyProxy(real_bpy)
try:
    server.start()
finally:
    mod.bpy = real_bpy

if not server.running:
    print("BOOTSTRAP: FAILED to start server", flush=True)
    sys.exit(1)
print("BOOTSTRAP: server listening on 127.0.0.1:9876", flush=True)

try:
    while True:
        # The same call bpy.app.timers would make, on the same thread it
        # would have made it on.
        server._drain_command_queue()
        time.sleep(0.02)
except KeyboardInterrupt:
    pass
finally:
    server.stop()
