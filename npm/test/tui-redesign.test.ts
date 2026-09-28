import assert from 'node:assert/strict';
import { test } from 'node:test';
import chalk from 'chalk';
import { mount } from './harness/tui.js';
import { WORD, WORDMARK_WIDTH, gradient, wordmarkRows } from '../src/tui/format/wordmark.js';
import { tildePath } from '../src/tui/format/units.js';
import type { ApprovalAction } from '../src/agent/mastraEngine.js';

const rowsOf = (screen: string): string[] => screen.split('\n');
const nonBlank = (screen: string): string[] => rowsOf(screen).map((l) => l.trimEnd()).filter((l) => l.trim() !== '');

// --- the wordmark ----------------------------------------------------------

test('the wordmark is three rows of one width, and the banner reserves exactly that', () => {
  const rows = wordmarkRows();
  assert.equal(rows.length, 3);
  for (const row of rows) assert.equal([...row].length, WORDMARK_WIDTH, `row ${JSON.stringify(row)}`);
  assert.equal(WORDMARK_WIDTH, 54);
});

test('no two letters of the wordmark are drawn the same', () => {
  // N and R were once near-identical and the mark read OMHIHAHHESS.
  const seen = new Map<string, string>();
  for (const letter of new Set(WORD)) {
    const glyph = wordmarkRows(letter).join('\n');
    const other = seen.get(glyph);
    assert.equal(other, undefined, `${letter} is drawn exactly like ${other}`);
    seen.set(glyph, letter);
  }
});

test('the gradient runs from one colour to the other, and is flat without hex', () => {
  const ramp = gradient('#000000', '#ff8000', 5);
  assert.equal(ramp.length, 5);
  assert.equal(ramp[0], '#000000');
  assert.equal(ramp[4], '#ff8000');
  assert.equal(ramp[2], '#804000');
  assert.deepEqual(gradient('cyan', 'blue', 3), ['cyan', 'cyan', 'cyan']);
});

test('the wordmark is drawn where it fits, and not where it does not', async () => {
  const wide = await mount({ columns: 100, rows: 30 });
  const narrow = await mount({ columns: 50, rows: 30 });
  try {
    assert.ok(wide.screen().includes(wordmarkRows()[0]), 'a wide terminal opens on the mark');
    assert.ok(!narrow.screen().includes('█'), 'a narrow one does not draw half of it');
    assert.match(narrow.screen(), /OMNIHARNESS/, 'and still names the product');
  } finally {
    wide.unmount();
    narrow.unmount();
  }
});

test('an ASCII terminal gets the name in letters, not the block mark', async () => {
  const before = process.env.OMNIHARNESS_ASCII;
  process.env.OMNIHARNESS_ASCII = '1';
  const app = await mount({ columns: 100, rows: 30 });
  try {
    assert.ok(!app.screen().includes('█'));
    assert.match(app.screen(), /OMNIHARNESS/);
  } finally {
    app.unmount();
    if (before === undefined) delete process.env.OMNIHARNESS_ASCII;
    else process.env.OMNIHARNESS_ASCII = before;
  }
});

// --- the opening dial ------------------------------------------------------

test('the mode dial names its key wherever the key fits', async () => {
  const app = await mount({ columns: 80, rows: 30 });
  await app.settle(60);
  try {
    assert.match(app.live(), /crazy\s+Ctrl\+E/);
  } finally {
    app.unmount();
  }
});

for (const columns of [50, 40]) {
  test(`the mode dial stays one row at ${columns} columns, giving up its key hint first`, async () => {
    const app = await mount({ columns, rows: 30 });
    await app.settle(60);
    try {
      const rows = rowsOf(app.live());
      const dial = rows.findIndex((line) => /\bmode\s+plan\b/.test(line));
      assert.ok(dial >= 0, 'the dial is drawn');
      assert.ok(!app.live().includes('Ctrl+E'), 'the key hint is dropped rather than wrapped');
      if (columns === 50) assert.match(rows[dial] ?? '', /crazy\s*$/, 'and dropped whole, not cut into a fragment');
      assert.match(rows[dial + 1] ?? '', /implement, verify, repair/, 'the description is the very next row');
      assert.ok(rows.length <= 30, `the live region fits the window, drew ${rows.length}`);
    } finally {
      app.unmount();
    }
  });
}

// --- a finished turn -------------------------------------------------------

test('the final reply carries a receipt naming the mode and the engine, once', async () => {
  const app = await mount({
    columns: 100, rows: 30, mode: 'build', model: 'auto/coding',
    run: async () => ({ content: 'done', model: 'auto/coding' }),
  });
  await app.submit('go');
  app.emit({ type: 'text', content: 'All done.', model: 'auto/coding', provider: 'anthropic' });
  await app.settle(120);
  try {
    const receipts = nonBlank(app.screen()).filter((line) => line.includes('▣'));
    assert.equal(receipts.length, 1, `one receipt, got ${JSON.stringify(receipts)}`);
    assert.match(receipts[0] ?? '', /▣ build · auto\/coding/);
    assert.ok(!/\$0|\b0 tokens\b/.test(receipts[0] ?? ''), 'no figure that was not measured');
  } finally {
    app.unmount();
  }
});

test('the user message band spans the window, out to the status line\'s edge', async () => {
  // The band is its background, and without colour Ink trims the padding that
  // carries it — so this is measured with colour on, as a terminal sees it.
  const level = chalk.level;
  chalk.level = 3;
  // 180 columns: the reading measure stops at 96, the frame runs on to the rail.
  const app = await mount({ columns: 180, rows: 30, run: () => new Promise(() => { /* running */ }) });
  await app.submit('investigate the fallback');
  await app.settle(80);
  try {
    const rows = rowsOf(app.screen());
    const band = rows.find((line) => /[›>] investigate the fallback/.test(line)) ?? '';
    // The status line is the row that ends with the workspace, right-aligned.
    const status = rowsOf(app.live()).find((line) => /\/tmp\/workspace\b/.test(line)) ?? '';
    assert.ok(band !== '' && status !== '');
    assert.ok(band.trimEnd().length < 96, 'the prompt itself is short, so the band is its padding');
    assert.equal(band.length, status.trimEnd().length, `band ${band.length} columns, status line ${status.trimEnd().length}`);
  } finally {
    chalk.level = level;
    app.unmount();
  }
});

// --- anchoring -------------------------------------------------------------

test('the first turn after the opening screen starts at the foot of the window', async () => {
  // The opening screen puts the composer on the floor. Without a spacer, the
  // first reply printed directly under the masthead and pulled the composer up
  // to the middle of the window: the floating prompt the redesign set out to fix.
  const rows = 30;
  const app = await mount({ columns: 100, rows, run: () => new Promise(() => { /* running */ }) });
  await app.settle(60);
  await app.submit('first task');
  await app.settle(80);
  try {
    // The output is every frame, erase sequences stripped, so the rows that
    // come directly before the printed prompt are what <Static> wrote with
    // it: the spacer, then the entry's own margin.
    const all = rowsOf(app.screen());
    const prompt = all.findIndex((line) => /[›>] first task/.test(line));
    assert.ok(prompt > 0, 'the prompt was printed');
    let blank = 0;
    while (prompt - blank - 1 >= 0 && (all[prompt - blank - 1] ?? '').trim() === '') blank += 1;
    assert.ok(blank >= 8, `the first prompt is printed after ${blank} blank rows, not pushed down to the composer`);
    assert.ok(rowsOf(app.live()).length <= rows);
  } finally {
    app.unmount();
  }
});

// --- the approval dialog ---------------------------------------------------

const gate = (): ApprovalAction => ({
  tool: 'run_command',
  input: { command: 'npm test' },
  scopes: [
    { id: 'cmd:exact:npm test', label: 'always run exactly: npm test' },
    { id: 'tool:run_command', label: 'always run any command' },
  ],
});

test('an approval is a framed dialog that names where the call will run', async () => {
  const app = await mount({ columns: 100, rows: 30, workspace: '/srv/acme' });
  const pending = app.requestApproval(gate());
  await app.settle(60);
  try {
    const rows = rowsOf(app.live());
    const top = rows.findIndex((line) => line.includes('╭'));
    const bottom = rows.findIndex((line) => line.includes('╰'));
    assert.ok(top >= 0 && bottom > top, 'the dialog is framed');
    const inside = rows.slice(top, bottom + 1).join('\n');
    assert.match(inside, /approval needed\s+run_command · \/srv\/acme/);
    assert.match(inside, /npm test/);
    assert.match(inside, /always run exactly/);
    assert.ok(rows.length <= 30);
  } finally {
    await app.type('n');
    await pending;
    app.unmount();
  }
});

test('an approval never makes the live region taller than a short window', async () => {
  for (const rows of [14, 18, 24]) {
    const app = await mount({ columns: 80, rows, run: () => new Promise(() => { /* running */ }) });
    await app.submit('go');
    // A stream long enough to take every row the plan gives it, so a dialog
    // taller than planned has no slack to hide in.
    app.emit({ type: 'text_delta', delta: Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n') });
    const pending = app.requestApproval(gate());
    await app.settle(60);
    try {
      const drawn = rowsOf(app.live()).length;
      assert.ok(drawn <= rows, `${rows}-row window drew ${drawn} rows`);
      assert.match(app.live(), /approval needed/);
      assert.match(app.live(), /always run exactly/, 'the scopes survive: they are the answer');
      if (rows === 14) assert.ok(!app.live().includes('╭'), 'a 14-row window gets the dialog without its frame');
    } finally {
      await app.type('n');
      await pending;
      app.unmount();
    }
  }
});

// --- paths -----------------------------------------------------------------

test('a path under home is shortened to ~, and nothing else is', () => {
  assert.equal(tildePath('/home/dev/acme', '/home/dev'), '~/acme');
  assert.equal(tildePath('/home/dev', '/home/dev'), '~');
  assert.equal(tildePath('/home/developer/x', '/home/dev'), '/home/developer/x');
  assert.equal(tildePath('/srv/acme', '/'), '/srv/acme');
});
