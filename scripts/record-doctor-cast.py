# Turns a captured run into a self-contained animated SVG.
#
# An asciinema cast would need a player, and the player would need a CDN or a
# vendored bundle — the landing page deliberately depends on neither. An SVG
# with CSS keyframes plays anywhere, needs no JavaScript at all, and degrades
# to a still frame if animation is disabled.
#
# The timings are the real ones from the capture: the five-second pause before
# the gateway answers is how long it actually took.
import json, io, re, sys, html

cap = json.load(io.open(sys.argv[1], encoding="utf-8"))
out_path = sys.argv[2]

PROMPT = "$ " + cap["cmd"]
HOLD = 2.4                      # beat at the end before the loop restarts
DUR = round(cap["total"] + HOLD, 2)

PAD_X, PAD_TOP, LH = 26, 62, 21
FS = 13.5
WIDTH = 940
HEIGHT = PAD_TOP + LH * (len(cap["lines"]) + 2) + 26

C_BG, C_CHROME, C_LINE = "#0b0d12", "#151922", "#232936"
C_INK, C_MUTED, C_ACCENT = "#e6e9f0", "#6f7889", "#2dd4bf"
C_OK, C_FAIL = "#8fd66f", "#f2637e"


# Two things in a real doctor run must never reach a public page: the masked
# key still leaks the last four characters of a live credential, and the
# persistence path carries the operator's account name. Redacted here rather
# than by re-recording, so the timings stay the ones actually measured. The
# placeholder key matches the one already used elsewhere on the site.
REDACTIONS = [
    (re.compile(r"\[key_[0-9a-zA-Z]{4}\]"), "[key_9999]"),
    (re.compile(r"[A-Za-z]:\\Users\\[^\\ ]+"), r"C:\Users\you"),
    (re.compile(r"/(?:home|Users)/[^/ ]+"), "/home/you"),
]


def redact(text):
    # Lambdas, not replacement strings: a Windows path replacement contains
    # backslashes, and re.sub reads those as escapes ("bad escape \U").
    for pattern, replacement in REDACTIONS:
        text = pattern.sub(lambda _m, r=replacement: r, text)
    return text


def esc(s):
    return html.escape(s, quote=True)


rows = []       # (delay_seconds, svg_content)
rows.append((0.0, f'<tspan fill="{C_ACCENT}">$</tspan> <tspan fill="{C_INK}">{esc(cap["cmd"])}</tspan>'))
for line in cap["lines"]:
    text = redact(line["text"])
    if not text.strip():
        rows.append((line["t"], ""))
        continue
    head, _, rest = text.partition(" ")
    if head in ("ok", "FAIL"):
        colour = C_OK if head == "ok" else C_FAIL
        # The label column is padded in the real output; keep it, so the
        # alignment on screen is the alignment the command produced.
        rows.append((line["t"],
                     f'<tspan fill="{colour}">{esc(head)}</tspan>'
                     f'<tspan fill="{C_MUTED}">{esc(rest)}</tspan>'))
    else:
        rows.append((line["t"], f'<tspan fill="{C_INK}">{esc(text)}</tspan>'))

keyframes, texts = [], []
for i, (t, content) in enumerate(rows):
    pct = max(0.0, min(99.0, 100.0 * t / DUR))
    # A hard cut rather than a fade: a terminal line does not fade in.
    keyframes.append(
        f"@keyframes r{i}{{0%,{pct:.3f}%{{opacity:0}}{pct + 0.001:.3f}%,100%{{opacity:1}}}}")
    y = PAD_TOP + LH * i
    texts.append(
        f'<text class="r r{i}" x="{PAD_X}" y="{y}">{content}</text>')

cursor_y = PAD_TOP + LH * len(rows) - 4

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {WIDTH} {HEIGHT}"
     width="{WIDTH}" height="{HEIGHT}" role="img"
     aria-label="A recording of omniharness doctor checking a live OmniRoute gateway: {len(cap["lines"])} lines, all checks passing.">
<style>
  .r {{ font-family: ui-monospace,'SF Mono','Cascadia Mono','JetBrains Mono',Menlo,Consolas,monospace;
        font-size: {FS}px; white-space: pre; animation-duration: {DUR}s;
        animation-iteration-count: infinite; animation-timing-function: steps(1,end); }}
  {chr(10).join(f'  .r{i} {{ animation-name: r{i}; }}' for i in range(len(rows)))}
  {chr(10).join('  ' + k for k in keyframes)}
  .cursor {{ animation: blink 1.1s steps(1,end) infinite; }}
  @keyframes blink {{ 0%,50% {{opacity:1}} 50.001%,100% {{opacity:0}} }}
  /* Without motion, show the finished output rather than an empty box. */
  @media (prefers-reduced-motion: reduce) {{
    .r {{ animation: none; opacity: 1; }}
    .cursor {{ animation: none; opacity: 0; }}
  }}
</style>
<rect width="{WIDTH}" height="{HEIGHT}" rx="12" fill="{C_BG}" stroke="{C_LINE}"/>
<rect width="{WIDTH}" height="38" rx="12" fill="{C_CHROME}"/>
<rect y="26" width="{WIDTH}" height="12" fill="{C_CHROME}"/>
<line x1="0" y1="38" x2="{WIDTH}" y2="38" stroke="{C_LINE}"/>
<circle cx="20" cy="19" r="5" fill="#f2637e"/><circle cx="38" cy="19" r="5" fill="#e6b955"/><circle cx="56" cy="19" r="5" fill="#8fd66f"/>
<text x="{WIDTH/2}" y="24" text-anchor="middle" fill="{C_MUTED}"
      font-family="ui-monospace,'SF Mono',Consolas,monospace" font-size="11.5">omniharness — doctor</text>
{chr(10).join(texts)}
<rect class="cursor" x="{PAD_X}" y="{cursor_y}" width="8" height="15" fill="{C_ACCENT}" opacity="0.9"/>
</svg>
'''

io.open(out_path, "w", encoding="utf-8", newline="\n").write(svg)
print(f"wrote {out_path}: {len(rows)} rows, {DUR}s loop, {HEIGHT}px tall")
