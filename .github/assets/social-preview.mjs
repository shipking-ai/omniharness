// Builds the repository's social preview (Settings -> General -> Social
// preview): a 1280x640 card set like the terminal's own home screen.
//
//   node .github/assets/social-preview.mjs > /tmp/card.html
//   then screenshot /tmp/card.html at 1280x640 (any headless browser).
//
// The wordmark is drawn from the same glyph rows the TUI prints
// (npm/src/tui/format/wordmark.ts, via the built npm/dist), one rectangle per
// half-block, so the card and the terminal cannot drift apart. The colours are
// the dark truecolor palette's (npm/src/tui/theme/palette.ts).
//
// FONT_DIR, if set, is a directory holding JetBrains Mono woff2 files
// (jetbrains-mono-latin-{400,700}-normal.woff2); they are embedded so the
// render does not depend on what the machine has installed.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { wordmarkRows, gradient, WORDMARK_WIDTH } = await import(join(root, 'npm/dist/tui/format/wordmark.js'));
const version = JSON.parse(readFileSync(join(root, 'npm/package.json'), 'utf8')).version;

const C = {
  bg: '#12151c', surface: '#1c2230', text: '#dce3ee', muted: '#8b93a7',
  teal: '#2dd4bf', blue: '#56b6ff', green: '#8fd66f', red: '#f2637e',
};

// One terminal cell is CELL wide and two half-blocks tall.
const CELL = 17;
const HALF = 17;
const ramp = gradient(C.teal, C.blue, WORDMARK_WIDTH);
const rects = [];
wordmarkRows().forEach((row, r) => {
  [...row].forEach((ch, c) => {
    const x = c * CELL;
    const y = r * HALF * 2;
    if (ch === '█' || ch === '▀') rects.push(`<rect x="${x}" y="${y}" width="${CELL}" height="${HALF}" fill="${ramp[c]}"/>`);
    if (ch === '█' || ch === '▄') rects.push(`<rect x="${x}" y="${y + HALF}" width="${CELL}" height="${HALF}" fill="${ramp[c]}"/>`);
  });
});
const markW = WORDMARK_WIDTH * CELL;
const markH = 3 * HALF * 2;

const fontDir = process.env.FONT_DIR;
const face = (weight) => {
  const file = fontDir && join(fontDir, `jetbrains-mono-latin-${weight}-normal.woff2`);
  if (!file || !existsSync(file)) return '';
  const data = readFileSync(file).toString('base64');
  return `@font-face{font-family:JBM;font-weight:${weight};src:url(data:font/woff2;base64,${data}) format("woff2")}`;
};

const mode = (name, color, on) => on
  ? `<span class="chip on" style="--c:${color}"><i></i>${name}</span>`
  : `<span class="chip">${name}</span>`;

process.stdout.write(`<!doctype html><html><head><meta charset="utf-8"><style>
${face(400)}${face(700)}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1280px;height:640px;overflow:hidden}
body{background:${C.bg};font-family:JBM,"JetBrains Mono","DejaVu Sans Mono",monospace;color:${C.text};
  display:flex;flex-direction:column;align-items:center;justify-content:center;position:relative}
body::before{content:"";position:absolute;inset:0;
  background:radial-gradient(640px 300px at 38% 30%,${C.teal}1c,transparent 70%),
             radial-gradient(560px 280px at 66% 36%,${C.blue}1a,transparent 70%)}
.wrap{position:relative;display:flex;flex-direction:column;align-items:center}
.tag{margin-top:30px;font-size:25px;letter-spacing:.2px}
.tag b{color:${C.teal};font-weight:700}
.composer{margin-top:34px;width:820px;background:${C.surface};border-left:4px solid ${C.green};
  padding:14px 22px 14px 20px;font-size:19px;line-height:30px;border-radius:2px}
.composer .ph{color:${C.muted}}
.composer .row{display:flex;justify-content:space-between}
.composer .mode{color:${C.green};font-weight:700}
.composer .dim{color:${C.muted}}
.modes{margin-top:22px;font-size:18px;color:${C.muted};display:flex;gap:26px;align-items:center}
.chip{position:relative}
.chip.on{color:var(--c);font-weight:700;padding-left:9px}
.chip.on i{position:absolute;left:0;top:3px;bottom:3px;width:3px;background:var(--c)}
.foot{position:absolute;left:56px;right:56px;bottom:38px;display:flex;justify-content:space-between;
  font-size:17px;color:${C.muted}}
.foot .cmd{color:${C.text}}
.foot .cmd::before{content:"$ ";color:${C.teal}}
.foot .v{color:${C.teal};font-weight:700}
</style></head><body><div class="wrap">
<svg width="${markW}" height="${markH}" viewBox="0 0 ${markW} ${markH}" shape-rendering="crispEdges">${rects.join('')}</svg>
<div class="tag">The agent harness built for <b>OmniRoute</b>.</div>
<div class="composer">
  <div class="ph">describe the work, or / for a command</div>
  <div class="row"><span><span class="mode">build</span><span class="dim"> · auto/best-coding</span></span><span class="dim">approvals manual</span></div>
</div>
<div class="modes">${mode('plan', C.blue, false)}${mode('build', C.green, true)}${mode('research', C.teal, false)}${mode('crazy', C.red, false)}</div>
</div>
<div class="foot"><span class="cmd">npm i -g omniharness-cli</span><span>github.com/shipking-ai/omniharness · <span class="v">v${version}</span></span></div>
</body></html>`);
