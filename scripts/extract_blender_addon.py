"""Extract blender-mcp's bundled Blender addon from its published wheel.

The addon ships inside the blender-mcp package rather than being distributed
on its own, and scripts/blender_headless.py needs it as a plain .py file to
hand to bpy.ops.preferences.addon_install.

    python scripts/extract_blender_addon.py /tmp/blender_mcp_addon.py

Downloads only; nothing from the wheel is executed here. The written file is
third-party code that Blender will run, so read it before you trust it.
"""

import io
import json
import sys
import urllib.request
import zipfile

PYPI = "https://pypi.org/pypi/blender-mcp/json"
MEMBER = "blender_mcp/bundled/addon.py"


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    dest = sys.argv[1]

    with urllib.request.urlopen(PYPI, timeout=30) as resp:
        meta = json.load(resp)
    wheels = [f for f in meta["urls"] if f["filename"].endswith(".whl")]
    if not wheels:
        print("no wheel published for blender-mcp", file=sys.stderr)
        return 1

    with urllib.request.urlopen(wheels[0]["url"], timeout=120) as resp:
        blob = resp.read()
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        if MEMBER not in z.namelist():
            print(f"{MEMBER} is not in {wheels[0]['filename']}", file=sys.stderr)
            return 1
        source = z.read(MEMBER)

    with open(dest, "wb") as fh:
        fh.write(source)
    print(f"wrote {dest} ({len(source)} bytes) from blender-mcp {meta['info']['version']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
