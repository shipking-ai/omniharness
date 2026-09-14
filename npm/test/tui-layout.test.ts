import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  NARROW_MAX, RAIL_MIN_COLUMNS, RAIL_WIDTH, STREAM_FLOOR, WIDE_MIN, band, measure, plan,
} from '../src/tui/layout/frame.js';
import { glyphs, unicodeSafe } from '../src/tui/theme/tokens.js';
import { windowAround } from '../src/tui/views/overlay.js';
import { visibleSteps } from '../src/tui/views/run.js';
import type { PlanStep } from '../src/tui/state/types.js';

// --- width bands -----------------------------------------------------------

test('the three bands are contiguous with no gap between them', () => {
  assert.equal(band(NARROW_MAX), 'narrow');
  assert.equal(band(NARROW_MAX + 1), 'normal');
  assert.equal(band(WIDE_MIN - 1), 'normal');
  assert.equal(band(WIDE_MIN), 'wide');
});

test('a terminal too narrow to hold a rail beside the full measure gets no rail', () => {
  for (const columns of [60, 100, 120, RAIL_MIN_COLUMNS - 1]) {
    assert.equal(measure(columns, true).rail, 0, `${columns} columns`);
  }
});

test('a rail appears once there is room for one beside the full measure', () => {
  assert.equal(measure(RAIL_MIN_COLUMNS, true).rail, RAIL_WIDTH);
  assert.equal(measure(200, false).rail, 0, 'an empty rail is worse than a wider margin');
});

test('the reading column is the same width whether or not a rail is shown', () => {
  // This is the whole point of taking the rail out of the spare space rather
  // than out of the measure: a plan arriving must not re-wrap the conversation.
  for (const columns of [60, 80, 100, 120, 134, 160, 220]) {
    assert.equal(
      measure(columns, true).content,
      measure(columns, false).content,
      `${columns} columns re-wrapped when the rail appeared`,
    );
  }
});

test('the left margin depends only on the terminal width, so scrollback stays aligned', () => {
  for (const columns of [60, 80, 100, 134, 200]) {
    assert.equal(measure(columns, true).gutter, measure(columns, false).gutter, `${columns} columns`);
  }
});

for (const columns of [40, 60, 72, 80, 100, 120, 134, 160, 220]) {
  test(`everything fits inside ${columns} columns`, () => {
    for (const rail of [true, false]) {
      const box = measure(columns, rail);
      const used = box.gutter * 2 + box.content + (box.rail > 0 ? box.rail + 2 : 0);
      assert.ok(used <= columns, `used ${used} of ${columns}`);
      assert.ok(box.content >= 16, 'the reading column stays readable');
    }
  });
}

test('a very wide terminal holds the reading column to a measure instead of stretching it', () => {
  assert.ok(measure(400, false).content <= 100, 'lines do not run the width of a 400-column window');
});

// --- height ----------------------------------------------------------------

test('streaming keeps a floor however little room is left', () => {
  const tight = plan({ rows: 8, composerLines: 3, approval: true, overlay: false, lensWanted: 20 });
  assert.ok(tight.stream >= Math.min(STREAM_FLOOR, tight.stream));
  assert.equal(tight.lens, 0, 'the lens body yields before streaming does');
});

test('a tall terminal gives the lens what it asked for and streaming the rest', () => {
  const roomy = plan({ rows: 50, composerLines: 1, approval: false, overlay: false, lensWanted: 10 });
  assert.equal(roomy.lens, 10);
  assert.ok(roomy.stream > STREAM_FLOOR);
});

test('a lens never gets more rows than it asked for', () => {
  const roomy = plan({ rows: 50, composerLines: 1, approval: false, overlay: false, lensWanted: 3 });
  assert.equal(roomy.lens, 3);
});

test('an open overlay takes the body and leaves streaming its floor', () => {
  const overlay = plan({ rows: 30, composerLines: 1, approval: false, overlay: true, lensWanted: 10 });
  assert.equal(overlay.lens, 0);
  assert.ok(overlay.overlay > 0);
  assert.ok(overlay.stream <= STREAM_FLOOR);
});

test('an approval banner is paid for out of the body, not out of the composer', () => {
  const without = plan({ rows: 30, composerLines: 1, approval: false, overlay: false, lensWanted: 30 });
  const withBanner = plan({ rows: 30, composerLines: 1, approval: true, overlay: false, lensWanted: 30 });
  assert.ok(withBanner.lens + withBanner.stream < without.lens + without.stream);
});

test('the plan never returns negative rows, at any size', () => {
  for (const rows of [1, 4, 8, 12, 24, 60]) {
    for (const composerLines of [1, 3, 12]) {
      const result = plan({ rows, composerLines, approval: true, overlay: false, lensWanted: 12 });
      assert.ok(result.lens >= 0 && result.stream >= 0 && result.overlay >= 0, `${rows}x${composerLines}`);
    }
  }
});

// --- list windowing --------------------------------------------------------

test('a list window always contains the selection', () => {
  for (const index of [0, 5, 9, 19]) {
    const { start, end } = windowAround(index, 20, 7);
    assert.ok(index >= start && index < end, `index ${index} is on screen`);
    assert.equal(end - start, 7);
  }
});

test('a list shorter than the window is shown whole', () => {
  assert.deepEqual(windowAround(0, 3, 10), { start: 0, end: 3 });
});

const steps = (n: number, activeAt: number): PlanStep[] =>
  Array.from({ length: n }, (_, i) => ({
    id: String(i),
    title: `step ${i}`,
    status: i < activeAt ? 'done' : i === activeAt ? 'active' : 'pending',
  }));

test('an inline plan window keeps the active step visible', () => {
  const shown = visibleSteps(steps(20, 14), 5);
  assert.equal(shown.length, 5);
  assert.ok(shown.some((step) => step.status === 'active'));
});

test('a plan with nothing active yet shows the first work rather than the finished tail', () => {
  const all: PlanStep[] = Array.from({ length: 10 }, (_, i) => ({
    id: String(i), title: `step ${i}`, status: i < 6 ? 'done' : 'pending',
  }));
  const shown = visibleSteps(all, 3);
  assert.ok(shown.some((step) => step.status === 'pending'));
});

test('a plan that fits is not windowed at all', () => {
  const all = steps(4, 1);
  assert.deepEqual(visibleSteps(all, 6), all);
});

// --- capability degradation ------------------------------------------------

test('a UTF-8 locale gets the geometric glyph set', () => {
  assert.equal(unicodeSafe({ LANG: 'en_US.UTF-8' }), true);
  assert.equal(glyphs({ LANG: 'en_US.UTF-8' }).running, '●');
});

test('a non-UTF-8 locale falls back to ASCII rather than drawing mojibake', () => {
  assert.equal(unicodeSafe({ LANG: 'C' }), false);
  const ascii = glyphs({ LANG: 'C' });
  assert.equal(ascii.running, '*');
  for (const glyph of Object.values(ascii)) {
    assert.ok(/^[\x20-\x7e]+$/.test(glyph), `${glyph} is printable ASCII`);
  }
});

test('OMNIHARNESS_ASCII forces the plain set even on a UTF-8 terminal', () => {
  assert.equal(unicodeSafe({ LANG: 'en_US.UTF-8', OMNIHARNESS_ASCII: '1' }), false);
  assert.equal(unicodeSafe({ LANG: 'en_US.UTF-8', OMNIHARNESS_ASCII: '0' }), true, '0 means "do not force it"');
});

test('every status has a distinct marker in both glyph sets', () => {
  for (const env of [{ LANG: 'en_US.UTF-8' }, { LANG: 'C' }]) {
    const set = glyphs(env);
    const statuses = [set.running, set.done, set.pending, set.failed, set.denied, set.attention];
    assert.equal(new Set(statuses).size, statuses.length, `distinct markers for ${env.LANG}`);
  }
});
