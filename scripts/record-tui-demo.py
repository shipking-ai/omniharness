#!/usr/bin/env python3
"""Record the real TUI into the animated SVG the README and landing page use.

The previous demo was drawn by hand, and it drifted: it was still showing a
footer of shortcuts the interface no longer has, and panels it no longer draws.
A picture of a terminal that does not match the terminal is worse than none, so
this captures the actual built CLI instead of describing it.

It drives `npm/dist/cli.js` in a real pty against a stub OmniRoute, reads the
screen back through a VT emulator (colours included), and emits a
self-contained SVG that cross-fades between the captured frames. No player, no
CDN, no JavaScript — the same constraint the doctor cast is built under.

    (cd npm && npm run build) && python3 scripts/record-tui-demo.py

Run it by hand whenever the interface changes shape; the capture includes real
elapsed times, so re-recording always produces a slightly different file and a
CI staleness check would only ever be noise.

Requires `pyte` (pip install pyte) and a built `npm/dist`.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import pty
import re
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CLI = REPO / "npm" / "dist" / "cli.js"
TARGETS = [REPO / ".github" / "assets" / "omniharness-demo.svg", REPO / "landing" / "assets" / "demo.svg"]

COLS, ROWS = 96, 26

# The frames the demo tells its story in. Each is (caption, keystrokes, wait-for).
PROMPT = "fix the provider fallback race in the streaming pipeline"

# --- the session the demo records -------------------------------------------

PLAN = [
    "reproduce the race under -race",
    "hold the mutex across the provider read",
    "add a regression test",
]


def sse(chunks: list[dict]) -> str:
    return "".join("data: %s\n\n" % json.dumps(c) for c in chunks) + "data: [DONE]\n\n"


def delta(text: str | None = None, tool: dict | None = None, finish: str | None = None) -> dict:
    body: dict = {}
    if text is not None:
        body["content"] = text
    if tool is not None:
        body["tool_calls"] = [tool]
    return {"choices": [{"index": 0, "delta": body, "finish_reason": finish}]}


def tool_call(index: int, name: str, args: dict) -> dict:
    return {
        "index": index,
        "id": "call-%d" % index,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(args)},
    }


HEADERS = {
    "x-omniroute-provider": "anthropic",
    "x-omniroute-model": "claude-sonnet-4-6",
    "x-omniroute-decision": "strategy=coding:reliable; provider=anthropic; latency_ms=812",
    "x-omniroute-tokens-in": "18400",
    "x-omniroute-tokens-out": "742",
    "x-omniroute-response-cost": "0.0412",
}


def respond(body: dict, n: int) -> str:
    text = json.dumps(body["messages"])
    if "worker agent" in text:
        time.sleep(2.2)
        return sse([delta(text="done"), delta(finish="stop")])
    if any(m.get("role") == "tool" for m in body["messages"]):
        return sse([delta(text="Planned %d independent steps." % len(PLAN)), delta(finish="stop")])
    return sse(
        [delta(text="Reading the fallback lifecycle before changing anything.")]
        + [delta(tool=tool_call(i, "update_todo", {"action": "add", "title": t})) for i, t in enumerate(PLAN)]
        + [delta(finish="tool_calls")]
    )


class Gateway:
    def __init__(self) -> None:
        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a: object) -> None:
                pass

            def do_GET(self) -> None:  # noqa: N802 - http.server's naming
                body = json.dumps(
                    {"object": "list", "data": [{"id": "auto/coding", "context_length": 200000}]}
                ).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self) -> None:  # noqa: N802
                size = int(self.headers.get("content-length", 0))
                payload = respond(json.loads(self.rfile.read(size) or b"{}"), 0).encode()
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                for key, value in HEADERS.items():
                    self.send_header(key, value)
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        # OmniRoute's own default port when it is free, so the route view shows
        # the endpoint a reader would actually have.
        try:
            self.server = ThreadingHTTPServer(("127.0.0.1", 20128), Handler)
        except OSError:
            self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = "http://localhost:%d" % self.server.server_address[1]

    def close(self) -> None:
        self.server.shutdown()


# --- capture -----------------------------------------------------------------


def capture() -> list[list[list[tuple[str, str, bool]]]]:
    """Drive the CLI and return frames of rows of (text, colour, bold) runs."""
    import pyte

    gateway = Gateway()
    # The banner shows the working directory and the route view shows the
    # gateway, so both are fixed: a random temp path and a random port would put
    # noise in a picture that is meant to be about the interface.
    scratch = os.path.join(tempfile.gettempdir(), "omniharness-demo")
    workspace = os.path.join(scratch, "omniharness")
    shutil.rmtree(scratch, ignore_errors=True)
    os.makedirs(workspace, exist_ok=True)
    screen = pyte.Screen(COLS, ROWS)
    stream = pyte.Stream(screen)
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    env = dict(
        os.environ,
        OMNIROUTE_URL=gateway.url,
        OMNIHARNESS_PLUGIN_PATH="",
        OMNIHARNESS_CONFIG_DIR=os.path.join(workspace, "cfg"),
        LC_ALL="C.UTF-8",
        TERM="xterm-256color",
        COLORTERM="truecolor",
    )
    proc = subprocess.Popen(
        ["node", str(CLI)], cwd=workspace, env=env, stdin=slave, stdout=slave, stderr=slave, close_fds=True
    )
    os.close(slave)

    def pump(seconds: float) -> None:
        end = time.time() + seconds
        while time.time() < end:
            ready, _, _ = select.select([master], [], [], 0.05)
            if not ready:
                continue
            try:
                chunk = os.read(master, 1 << 16)
            except OSError:
                return
            if not chunk:
                return
            stream.feed(chunk.decode("utf8", "replace"))

    def send(data: str, wait: float = 0.4) -> None:
        os.write(master, data.encode())
        pump(wait)

    def wait_for(needle: str, timeout: float = 30.0) -> None:
        end = time.time() + timeout
        while time.time() < end:
            pump(0.2)
            if any(needle in row for row in screen.display):
                return

    frames: list[list[list[tuple[str, str, bool]]]] = []

    def snap() -> None:
        frames.append(read_frame(screen))

    try:
        pump(1.8)
        snap()                                        # 1 — the empty session
        # Text and Enter are separate writes: one chunk carrying both is a
        # paste, which is exactly what the interface treats it as.
        send("/mode crazy", wait=0.3)
        send("\r", wait=0.9)
        send(PROMPT, wait=0.7)
        snap()                                        # 2 — a task, typed
        send("\r", wait=0.3)
        wait_for("Planned")
        pump(1.2)
        snap()                                        # 3 — planned, fanned out
        send("\x0c", wait=0.9)                        # Ctrl+L → agents
        snap()                                        # 4 — the workers
        send("\x0c", wait=0.4)                        # → plan
        send("\x0c", wait=1.0)                        # → route
        snap()                                        # 5 — the route that answered
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
        gateway.close()
        shutil.rmtree(scratch, ignore_errors=True)
    return frames


# pyte reports 24-bit colours as bare hex and the rest by name. Dimness is not
# modelled at all, which costs nothing here: everything secondary in this
# interface carries an explicit muted colour rather than relying on SGR 2.
NAMED = {
    "default": "#d5d9e2",
    "black": "#1b1f27",
    "red": "#f2637e",
    "green": "#8fd66f",
    "yellow": "#e6b955",
    "blue": "#56b6ff",
    "magenta": "#c58af9",
    "cyan": "#2dd4bf",
    "white": "#d5d9e2",
    "brightblack": "#8b93a7",
}


def read_frame(screen: object) -> list[list[tuple[str, str, bool]]]:
    rows: list[list[tuple[str, str, bool]]] = []
    for y in range(ROWS):
        buffer_row = screen.buffer[y]
        runs: list[tuple[str, str, bool]] = []
        text, colour, bold = "", None, False
        for x in range(COLS):
            cell = buffer_row[x]
            fg = cell.fg
            hexed = "#" + fg.lower() if re.fullmatch(r"[0-9a-fA-F]{6}", fg or "") else NAMED.get(fg, NAMED["default"])
            if colour is None:
                colour, bold = hexed, bool(cell.bold)
            if hexed != colour or bool(cell.bold) != bold:
                runs.append((text, colour, bold))
                text, colour, bold = "", hexed, bool(cell.bold)
            text += cell.data
        runs.append((text, colour or NAMED["default"], bold))
        rows.append([(t.rstrip(), c, b) if i == len(runs) - 1 else (t, c, b) for i, (t, c, b) in enumerate(runs)])
    while rows and not any(t.strip() for t, _, _ in rows[-1]):
        rows.pop()
    return rows


# --- render ------------------------------------------------------------------

PAD_X, PAD_TOP, LH, FS, CW = 24, 58, 17.5, 12.5, 7.52
HOLD = 3.0
BG, CHROME, EDGE = "#0e1016", "#14171f", "#262b38"


def render(frames: list[list[list[tuple[str, str, bool]]]]) -> str:
    height = int(PAD_TOP + LH * ROWS + 22)
    width = int(PAD_X * 2 + CW * COLS)
    total = round(HOLD * len(frames), 2)
    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, '
        f"'Liberation Mono', monospace\" font-size=\"{FS}\" role=\"img\" "
        f'aria-label="OmniHarness terminal: a task, the plan it produced, the workers running it, '
        f'and the route that answered">',
        f'  <rect x="0.5" y="0.5" width="{width - 1}" height="{height - 1}" rx="12" fill="{BG}" stroke="{EDGE}"/>',
        f'  <path d="M12 0.5 H{width - 12} A11.5 11.5 0 0 1 {width - 0.5} 12 V40 H0.5 V12 '
        f'A11.5 11.5 0 0 1 12 0.5 Z" fill="{CHROME}" stroke="{EDGE}"/>',
        '  <circle cx="24" cy="20.5" r="6" fill="#f2637e"/>',
        '  <circle cx="46" cy="20.5" r="6" fill="#e6b955"/>',
        '  <circle cx="68" cy="20.5" r="6" fill="#8fd66f"/>',
        '  <text x="96" y="25" fill="#8b93a7" letter-spacing="1.5">omniharness</text>',
    ]
    step = 1.0 / len(frames)
    for index, rows in enumerate(frames):
        start = index * step
        # Each frame is opaque for its own slot and hidden for the others.
        times = [0.0, max(0.0, start - 0.01), start, start + step - 0.01, min(1.0, start + step), 1.0]
        values = [0, 0, 1, 1, 0, 0]
        if index == 0:
            values[0] = values[1] = 1
        if index == len(frames) - 1:
            values[-1] = 1
        out.append(f'  <g opacity="{1 if index == 0 else 0}">')
        out.append(
            f'    <animate attributeName="opacity" dur="{total}s" repeatCount="indefinite" '
            f'values="{";".join(str(v) for v in values)}" '
            f'keyTimes="{";".join(f"{t:.4f}" for t in times)}"/>'
        )
        for y, runs in enumerate(rows):
            x = PAD_X
            baseline = PAD_TOP + LH * y
            for text, colour, bold in runs:
                if text.strip():
                    weight = ' font-weight="600"' if bold else ""
                    out.append(
                        f'    <text x="{x:.1f}" y="{baseline:.1f}" fill="{colour}"{weight} '
                        f'xml:space="preserve">{escape(text)}</text>'
                    )
                x += CW * len(text)
        out.append("  </g>")
    out.append("</svg>")
    return "\n".join(out) + "\n"


def escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def main() -> int:
    argparse.ArgumentParser(description=__doc__).parse_args()

    if not CLI.exists():
        print(f"build the CLI first: (cd npm && npm run build) — {CLI} is missing", file=sys.stderr)
        return 2

    svg = render(capture())
    for target in TARGETS:
        target.write_text(svg, encoding="utf8")
        print(f"wrote {target.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
