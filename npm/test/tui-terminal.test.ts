/**
 * Terminal-level behaviour: the probes the interface sends, the replies the
 * terminal sends back, and what happens when a window is resized.
 *
 * These are regressions with real screenshots behind them, and they survive the
 * rebuild unchanged in substance: the primitives they exercise (the
 * synchronized-output probe, the kitty probe, coalesced resize delivery) were
 * kept precisely because they were correct.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeStdout, mount, sleep, strip } from './harness/tui.js';
import { SYNC_BEGIN, SYNC_END } from '../src/tui/term/caps.js';
import { debounceResizeEvents } from '../src/tui/term/resize.js';

/** The last frame written: Ink starts each one by homing the cursor. */
const lastFrame = (output: string): string => {
  const parts = output.split('\x1b[G');
  return strip(parts[parts.length - 1] ?? output);
};

// The reply a terminal sends to the synchronized-output query this interface
// sends at startup. It arrives on the same stdin the composer reads from, so
// anything that fails to claim it types it into the composer as text.
const SYNC_REPLY = '\x1b[?2026;2$y';

test('a late synchronized-output reply is not typed into the composer', async () => {
  const app = await mount({ columns: 120 });
  // Past the kitty probe's own window — the point at which, before this was
  // split into two independent probes, nothing was left listening.
  await app.settle(350);
  await app.type(SYNC_REPLY);
  app.unmount();

  const frame = lastFrame(app.stdout.output);
  assert.ok(!frame.includes('2026') && !frame.includes('$y'), `the terminal's own reply reached the screen:\n${frame}`);
});

test('a prompt synchronized-output reply is still recognised', async () => {
  const app = await mount({ columns: 120 });
  await app.type(SYNC_REPLY);
  app.unmount();

  const frame = lastFrame(app.stdout.output);
  assert.ok(!frame.includes('2026') && !frame.includes('$y'), `leaked even on the fast path:\n${frame}`);
});

test('an ordinary paste still lands in the composer', async () => {
  const app = await mount({ columns: 120 });
  await app.type('hello world');
  app.unmount();

  const frame = lastFrame(app.stdout.output);
  assert.ok(frame.includes('hello world'), `an ordinary paste must still be inserted:\n${frame}`);
});

test('a late reply still turns synchronized output on', async () => {
  // Not appearing in the composer is only half of "handled". The feature the
  // probe exists for — bracketing each frame so the terminal composites it
  // atomically instead of tearing — has to actually switch on.
  const app = await mount({ columns: 120 });
  await app.settle(350);
  const before = app.stdout.output.length;
  await app.type(SYNC_REPLY);
  await app.type('x');
  app.unmount();

  const written = app.stdout.output.slice(before);
  assert.ok(
    written.includes(SYNC_BEGIN) && written.includes(SYNC_END),
    `a write after the late reply was not wrapped, so synchronized output never turned on:\n${JSON.stringify(written)}`,
  );
});

test('a burst of resize events during a maximise/restore produces one redraw, not one per event', async () => {
  // What a Windows Terminal maximise-then-restore actually sends: not one
  // resize but a burst of intermediate sizes a few milliseconds apart, as the
  // window animates. Reacting to each one is what left duplicated prompt boxes
  // and orphaned frame fragments on screen.
  const counting = new FakeStdout(120, 40);
  // As cli.tsx does: the wrapper has to be the object Ink subscribes to, or
  // Ink's own internal listener still redraws once per raw event.
  const stdout = debounceResizeEvents(counting as unknown as NodeJS.WriteStream, 80);
  const app = await mount({ into: stdout as unknown as FakeStdout });
  await app.settle(120);

  const before = counting.writes;
  const sizes: readonly (readonly [number, number])[] = [
    [120, 40], [110, 38], [95, 34], [80, 30], [70, 26], [80, 30],
  ];
  for (const [columns, rows] of sizes) {
    counting.columns = columns;
    counting.rows = rows;
    counting.emit('resize');
    await sleep(15);
  }
  const duringBurst = counting.writes - before;

  await sleep(200);
  const afterSettle = counting.writes - before;
  app.unmount();

  assert.ok(
    duringBurst <= 1,
    `the burst itself triggered ${duringBurst} writes; undebounced resize handling redraws once per event`,
  );
  assert.ok(
    afterSettle >= 1,
    'the settled size must still produce a redraw — debouncing must not swallow the resize outright',
  );
});

test('a resize is reflected in the layout once it settles', async () => {
  const app = await mount({ columns: 120, rows: 40 });
  await app.submit('a task');
  await app.settle(60);

  app.stdout.columns = 60;
  app.stdout.rows = 24;
  app.stdout.emit('resize');
  await app.settle(120);

  const frame = lastFrame(app.stdout.output);
  for (const line of frame.split('\n')) {
    assert.ok(line.length <= 60, `a row of ${line.length} columns survived the shrink: ${JSON.stringify(line)}`);
  }
  app.unmount();
});
