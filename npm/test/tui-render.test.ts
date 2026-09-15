import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mount } from './harness/tui.js';

// --- first screen ----------------------------------------------------------

test('the opening screen states what this session actually is', async () => {
  const app = await mount({
    columns: 100, model: 'auto/coding:reliable', mode: 'build', workspace: '/srv/project',
  });
  const screen = app.screen();
  assert.match(screen, /OMNIHARNESS/);
  assert.match(screen, /\/srv\/project/);
  assert.match(screen, /auto\/coding:reliable/);
  assert.match(screen, /build/);
  app.unmount();
});

test('a fresh workspace shows no empty sections and no invented numbers', async () => {
  const app = await mount({ columns: 100 });
  const screen = app.screen();
  for (const absent of ['tokens', 'cost', '$0', 'latency', 'failovers', 'last session', 'skill']) {
    assert.ok(!screen.includes(absent), `nothing claims "${absent}" before anything has happened`);
  }
  // "plan" appears as the name of a mode on the opening screen, which is not a
  // plan heading. A plan heading is the one that carries a step count.
  assert.ok(!/\bplan\s+\d+\/\d+/.test(screen), 'no plan progress before there is a plan');
  assert.ok(!/\b\d+\/\d+\b/.test(screen), 'no counters of any kind before anything has happened');
  app.unmount();
});

test('the composer invites a task and names the way to find everything else', async () => {
  const app = await mount({ columns: 100 });
  assert.match(app.screen(), /describe the work/);
  assert.match(app.screen(), /Ctrl\+K commands/);
  app.unmount();
});

// --- a turn ----------------------------------------------------------------

test('a submitted prompt becomes a transcript entry and starts a run', async () => {
  const app = await mount({ columns: 100 });
  await app.submit('fix the fallback race');
  assert.deepEqual(app.calls.runs, ['fix the fallback race']);
  assert.match(app.screen(), /fix the fallback race/);
  app.unmount();
});

test('an empty prompt starts nothing', async () => {
  const app = await mount({ columns: 100 });
  await app.submit('');
  await app.submit('   ');
  assert.deepEqual(app.calls.runs, []);
  app.unmount();
});

test('streamed text appears while it streams and settles once when it is final', async () => {
  const app = await mount({ columns: 100, run: () => new Promise(() => { /* stays running */ }) });
  await app.submit('go');
  app.emit({ type: 'text_delta', delta: 'Reading the ' });
  app.emit({ type: 'text_delta', delta: 'fallback path.' });
  await app.settle();
  assert.match(app.screen(), /Reading the fallback path\./);

  app.emit({ type: 'text', content: 'Reading the fallback path.', model: 'claude-sonnet-4-6', provider: 'anthropic' });
  await app.settle();
  assert.match(app.live(), /via anthropic/, 'the provider that answered is named on screen');
  assert.ok(
    !app.live().includes('Reading the fallback path.'),
    'the settled reply hands off to scrollback instead of being redrawn live under itself',
  );

  // Which model answered is detail, and detail belongs to the route lens: the
  // status line names the engine that was asked for and the provider that
  // replied, and nothing on the run screen repeats either.
  for (let i = 0; i < 3; i += 1) await app.type('\x0c');
  await app.settle(40);
  assert.match(app.screen(), /model\s+claude-sonnet-4-6/);
  app.unmount();
});

test('reasoning is labelled and kept visually secondary to the answer', async () => {
  const app = await mount({ columns: 100, run: () => new Promise(() => { /* stays running */ }) });
  await app.submit('go');
  app.emit({ type: 'thinking_delta', delta: 'the race is in the retry loop' });
  await app.settle();
  const screen = app.screen();
  assert.match(screen, /thinking/);
  assert.match(screen, /the race is in the retry loop/);
  app.unmount();
});

test('a long stream shows its newest rows rather than its oldest', async () => {
  const app = await mount({ columns: 100, rows: 20, run: () => new Promise(() => { /* running */ }) });
  await app.submit('go');
  for (let i = 0; i < 60; i += 1) app.emit({ type: 'text_delta', delta: `line ${i}\n` });
  await app.settle(80);
  const screen = app.screen();
  assert.match(screen, /line 59/, 'the newest line is on screen');
  app.unmount();
});

test('the plan appears with progress once the harness reports one', async () => {
  const app = await mount({ columns: 100, run: () => new Promise(() => { /* running */ }) });
  await app.submit('go');
  app.emit({ type: 'todos', todos: [
    { id: '1', title: 'inspect fallback lifecycle', status: 'done' },
    { id: '2', title: 'reproduce the race', status: 'active' },
    { id: '3', title: 'add a regression test', status: 'pending' },
  ] });
  await app.settle();
  const screen = app.screen();
  assert.match(screen, /plan/);
  assert.match(screen, /1\/3/);
  assert.match(screen, /reproduce the race/);
  app.unmount();
});

test('a failed run is reported in the transcript rather than swallowed', async () => {
  const app = await mount({ columns: 100, run: async () => { throw new Error('gateway refused the request'); } });
  await app.submit('go');
  await app.settle(120);
  assert.match(app.screen(), /gateway refused the request/);
  app.unmount();
});

// --- widths ----------------------------------------------------------------

for (const columns of [56, 72, 100, 140, 200]) {
  test(`nothing overflows at ${columns} columns`, async () => {
    const app = await mount({
      columns, rows: 30, run: () => new Promise(() => { /* running */ }),
      model: 'auto/coding:reliable-long-engine-name',
    });
    await app.submit('investigate the provider fallback race in the streaming pipeline');
    app.emit({ type: 'todos', todos: [
      { id: '1', title: 'a step with a title long enough to need shortening at every width', status: 'active' },
    ] });
    app.emit({ type: 'tool_start', tool: 'run_command', input: { command: 'go test ./internal/gateway/... -run TestFallback -race' }, id: 'c1' });
    app.emit({ type: 'route', fallback: false, attempts: 0, provider: 'anthropic', model: 'claude-sonnet-4-6', latencyMs: 812 });
    await app.settle(80);

    try {
      for (const line of app.screen().split('\n')) {
        assert.ok(line.length <= columns, `a row of ${line.length} columns does not fit in ${columns}: ${JSON.stringify(line)}`);
      }

      // The overlays too. They were outside this check, and the palette — the
      // one surface that has to work, since it is where the rest of the keymap
      // is written down — was wrapping every long row at 120 columns.
      app.stdout.clear();
      await app.type('\x0b'); // Ctrl+K
      await app.settle(60);
      for (const line of app.screen().split('\n')) {
        assert.ok(line.length <= columns, `a palette row of ${line.length} columns does not fit in ${columns}: ${JSON.stringify(line)}`);
      }
    } finally {
      app.unmount();
    }
  });
}

/**
 * The status line: the middle of the three chrome rows that close every frame
 * (composer, status, hints). Identified by position rather than by content —
 * every content pattern it has had so far eventually collided with something
 * else on the screen.
 */
const statusRow = (screen: string): string => {
  const rows = screen.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim() !== '');
  return rows.at(-2) ?? '';
};

test('a narrow terminal drops secondary metadata instead of truncating it', async () => {
  const wide = await mount({ columns: 100, model: 'auto/coding' });
  const narrow = await mount({ columns: 56, model: 'auto/coding' });
  try {
    assert.match(statusRow(wide.screen()), /auto\/coding/, 'a normal terminal names the engine');
    const row = statusRow(narrow.screen());
    assert.match(row, /manual/, 'the narrow status line still says how approvals are handled');
    assert.ok(!row.includes('auto/coding'), 'the engine name is dropped, not squeezed in');
  } finally {
    wide.unmount();
    narrow.unmount();
  }
});

test('a wide terminal shows a rail only once there is something to put in it', async () => {
  const app = await mount({ columns: 150, rows: 40, run: () => new Promise(() => { /* running */ }) });
  const before = app.screen();
  // The heading, not the word: "fan out across parallel agents" is the crazy
  // mode's description on the opening screen, and is not a rail.
  assert.ok(
    !/^\s*agents\s/m.test(before), 'no rail headings before any work exists',
  );

  await app.submit('go');
  app.emit({ type: 'agent', id: 'A1', label: 'A1', status: 'working', note: 'writing the test' });
  app.emit({ type: 'todos', todos: [{ id: '1', title: 'write the test', status: 'active' }] });
  await app.settle(80);
  const after = app.screen();
  assert.match(after, /writing the test/);
  app.unmount();
});

// --- terminal capability ---------------------------------------------------

test('the interface never switches to the alternate screen', async () => {
  const app = await mount({ columns: 100 });
  await app.submit('hello');
  await app.settle();
  for (const sequence of ['?1049h', '?1049l']) {
    assert.ok(!app.stdout.output.includes(sequence), `the alternate screen (${sequence}) would destroy scrollback`);
  }
  app.unmount();
});

test('the kitty protocol is pushed on start and popped on unmount', async () => {
  const app = await mount({ columns: 100 });
  assert.ok(app.stdout.output.includes('\x1b[>1u'), 'pushed');
  app.unmount();
  await app.settle(30);
  assert.ok(app.stdout.output.includes('\x1b[<1u'), 'popped, so the terminal is left as it was found');
});

test('the newline hint follows what the terminal answered about the kitty protocol', async () => {
  // Offered once there is a first line to add a second one to, and not before:
  // an empty composer has nothing to continue.
  const legacy = await mount({ columns: 100 });
  await legacy.settle(400);
  assert.ok(!legacy.live().includes('newline'), 'nothing to continue yet, so nothing is offered');
  await legacy.type('a task');
  assert.match(legacy.live(), /Ctrl\+J newline/);
  legacy.unmount();

  const kitty = await mount({ columns: 100, kitty: true });
  await kitty.settle(60);
  await kitty.type('a task');
  assert.match(kitty.live(), /shift\+enter newline/);
  kitty.unmount();
});

test('unmounting stops the engine', async () => {
  const app = await mount({ columns: 100 });
  app.unmount();
  await app.settle(20);
  assert.ok(app.calls.stopped > 0);
});

// --- resilience -------------------------------------------------------------

test('a dropped connection says what to do about it, and the next prompt still runs', async () => {
  let attempt = 0;
  const app = await mount({
    columns: 100,
    endpoint: 'http://localhost:20128',
    run: async () => {
      attempt += 1;
      // What Node's fetch actually throws when nothing is listening.
      if (attempt === 1) throw new Error('fetch failed');
      return { content: 'back online', model: 'auto/coding' };
    },
  });
  try {
    await app.submit('first');
    await app.settle(150);
    const screen = app.screen();
    assert.match(screen, /cannot reach OmniRoute at http:\/\/localhost:20128/);
    assert.match(screen, /check that it is running/);
    assert.ok(!/^\s*fetch failed\s*$/m.test(screen), '"fetch failed" on its own tells nobody anything');

    await app.submit('second');
    await app.settle(150);
    assert.deepEqual(app.calls.runs, ['first', 'second'], 'the interface is still usable after a failure');
  } finally {
    app.unmount();
  }
});

test('an error that already says something useful is passed through unchanged', async () => {
  const app = await mount({
    columns: 100,
    run: async () => { throw new Error('too many tool turns (limit 40)'); },
  });
  try {
    await app.submit('go');
    await app.settle(150);
    assert.match(app.screen(), /too many tool turns \(limit 40\)/);
  } finally {
    app.unmount();
  }
});

test('an event the interface does not recognise is ignored, not rendered as a blank row', async () => {
  const app = await mount({ columns: 100, run: () => new Promise<never>(() => { /* running */ }) });
  await app.submit('go');
  const before = app.screen().length;
  // Shapes a future engine could emit, and shapes a broken one could.
  const rogue = [
    { type: 'not_a_real_event', payload: 1 },
    { type: 'tool_result', tool: 'read_file' },
    { type: 'agent' },
    { type: 'todos', todos: [] },
    {},
  ];
  for (const event of rogue) {
    assert.doesNotThrow(() => app.emit(event as never), `emitting ${JSON.stringify(event)} must not throw into the engine`);
  }
  await app.settle(60);
  assert.match(app.screen(), /go/, 'the session is still on screen');
  assert.ok(app.screen().length >= before);
  app.unmount();
});

test('a cancelled run returns the interface to a usable state', async () => {
  const app = await mount({
    columns: 100,
    run: () => new Promise((resolve) => setTimeout(() => resolve({ content: '(cancelled)', model: 'm' }), 60)),
  });
  await app.submit('go');
  await app.type('\x03'); // Ctrl+C
  assert.equal(app.calls.cancels, 1);
  await app.settle(200);
  assert.match(app.screen(), /describe the work/, 'the composer is back');
  app.unmount();
});

test('a cancelled turn reads as cancelled, not as the assistant saying so', async () => {
  const app = await mount({
    columns: 100,
    // Long enough that the keystroke lands while the turn is genuinely running.
    run: () => new Promise((resolve) => setTimeout(() => resolve({ content: '(cancelled)', model: 'm' }), 400)),
  });
  try {
    await app.submit('take your time');
    await app.type('\x03'); // Ctrl+C
    // What the engine does on an abort: closes the turn with a placeholder.
    assert.equal(app.calls.cancels, 1, 'the engine was asked to stop');
    app.emit({ type: 'text', content: '(cancelled)', model: 'm' });
    await app.settle(600);
    const screen = app.screen();
    assert.match(screen, /cancelled/);
    assert.ok(!screen.includes('(cancelled)'), 'the placeholder the engine closes with is not a reply');
  } finally {
    app.unmount();
  }
});

test('the wide-terminal rail never repeats the lens the user just opened', async () => {
  const app = await mount({ columns: 160, rows: 40, run: () => new Promise<never>(() => { /* running */ }) });
  try {
    await app.submit('go');
    app.emit({ type: 'todos', todos: [{ id: '1', title: 'a distinctive step title', status: 'active' }] });
    await app.settle(80);
    const onRun = app.screen().split('\n').filter((line) => line.includes('a distinctive step title'));
    assert.ok(onRun.length >= 1, 'the run view shows it, in the body and the rail');

    await app.type('\x0c'); // Ctrl+L → agents
    await app.type('\x0c'); // → plan
    await app.settle(80);
    const frame = app.screen().slice(app.screen().lastIndexOf('OMNIHARNESS'));
    const perRow = frame.split('\n').map((line) => line.split('a distinctive step title').length - 1);
    assert.ok(perRow.every((n) => n <= 1), 'the plan lens and the rail drew the same list side by side');
  } finally {
    app.unmount();
  }
});

test('notice severity survives a terminal with no colour', async () => {
  const app = await mount({ columns: 100, run: async () => { throw new Error('something broke'); } });
  try {
    await app.submit('go');
    await app.settle(150);
    const row = app.screen().split('\n').find((line) => line.includes('something broke')) ?? '';
    assert.match(row.trimStart(), /^✗/, 'the marker, not the colour, says this is a failure');
  } finally {
    app.unmount();
  }
});

test('a reply keeps the paragraph breaks it was written with', async () => {
  const app = await mount({ columns: 70, rows: 30, run: () => new Promise(() => { /* running */ }) });
  await app.submit('go');
  app.emit({
    type: 'text', model: 'm',
    content: 'First paragraph.\n\nSecond paragraph.\n\n```go\nx := 1\n```\n\nLast paragraph.',
  });
  await app.settle(80);

  const rows = app.screen().split('\n').map((line) => line.trim());
  const index = (needle: string): number => rows.findIndex((line) => line.includes(needle));
  const first = index('First paragraph.');
  assert.ok(first >= 0, 'the reply is on screen');
  // Ink gives a Text with no children no height, so a blank row has to be
  // rendered as something. Without that every break here collapsed and a long
  // reply arrived as one wall of text.
  assert.equal(rows[first + 1], '', 'a blank row separates the paragraphs');
  assert.equal(rows[index('Second paragraph.') + 1], '', 'and the next one');
  assert.equal(rows[index('x := 1') + 1], '', 'and the code fence is set apart from what follows');
  app.unmount();
});

// --- the opening state -----------------------------------------------------

test('an untouched session fills the window instead of sitting above a void', async () => {
  const app = await mount({ columns: 100, rows: 30 });
  await app.settle(60);
  const rows = app.live().split('\n');
  const composer = rows.findIndex((line) => line.includes('describe the work'));
  assert.ok(composer >= 0, 'the composer is on screen');
  // The command surface sits on the floor of the window: the status line and
  // the hint line are all that follow it.
  const after = rows.slice(composer + 1).filter((line) => line.trim() !== '');
  assert.equal(after.length, 2, `only the status and hint rows follow the composer, got ${JSON.stringify(after)}`);
  assert.ok(composer >= 12, `the composer is near the foot of a 30-row window, not at row ${composer}`);
  app.unmount();
});

test('the opening screen names the modes and marks the one in force', async () => {
  const app = await mount({ columns: 100, rows: 30, mode: 'research' });
  await app.settle(60);
  const rows = app.live().split('\n');
  for (const mode of ['plan', 'build', 'research', 'crazy']) {
    assert.ok(rows.some((line) => line.includes(mode)), `${mode} is offered`);
  }
  const current = rows.find((line) => line.includes('research')) ?? '';
  // The mode in force is marked with the composer's own spine, in the same
  // column as the composer's, so the two read as one device.
  assert.match(current.trimStart(), /^[|┃]/, 'the mode in force carries the command surface mark');
  const others = rows.filter((line) => /^\s+(plan|build|crazy)\s/.test(line));
  assert.equal(others.length, 3, 'the other three are listed');
  for (const line of others) {
    assert.ok(!/^[|┃]/.test(line.trimStart()), `only one mode is marked, not ${JSON.stringify(line)}`);
  }
  app.unmount();
});

test('the opening screen gives up rows rather than overflowing a short window', async () => {
  for (const rows of [8, 10, 14, 24]) {
    const app = await mount({ columns: 90, rows });
    await app.settle(60);
    try {
      // The live region must never be taller than the window: Ink redraws by
      // walking back over the rows it wrote, and one row too many makes the
      // terminal scroll under it and the next redraw eat the transcript.
      const drawn = app.live().split('\n').length;
      assert.ok(drawn <= rows, `${rows}-row window drew ${drawn} rows`);
      assert.match(app.live(), /describe the work/, `${rows}-row window still has a composer`);
    } finally {
      app.unmount();
    }
  }
});

test('the opening screen is gone for good once there is a conversation', async () => {
  const app = await mount({ columns: 100, rows: 30, run: async () => ({ content: 'done', model: 'm' }) });
  await app.settle(60);
  assert.match(app.live(), /implement, verify, repair/, 'the mode list is there to begin with');

  await app.submit('go');
  await app.settle(120);
  assert.ok(!app.live().includes('implement, verify, repair'), 'and gone once the session has a transcript');
  app.unmount();
});

// --- the instrument row ----------------------------------------------------

test('the status line leads with what is happening and does not repeat the masthead', async () => {
  const app = await mount({ columns: 100, rows: 30, mode: 'build', model: 'auto/coding', workspace: '/srv/p' });
  await app.settle(60);
  const row = statusRow(app.live());
  // What the harness is doing is the only thing on this row anyone reads while
  // a turn is in flight, so it leads and it is the only thing on the left. The
  // mode is a setting and sits with the other settings.
  assert.match(row, /^\s*ready\b/, 'the phase leads');
  assert.match(row, /build .* auto\/coding/, 'the mode is grouped with the engine, not set against the phase');

  // The masthead used to carry the engine, the mode and the permission as well,
  // three rows above the status line that carries all three live.
  const masthead = app.screen().split('\n').slice(0, 3).join('\n');
  assert.match(masthead, /OMNIHARNESS/);
  assert.match(masthead, /\/srv\/p/);
  for (const live of ['auto/coding', 'build', 'manual']) {
    assert.ok(!masthead.includes(live), `"${live}" belongs to the status line, not the masthead`);
  }
  app.unmount();
});

test('an elevated permission is coloured as the standing risk it is', async () => {
  const { theme } = await import('../src/tui/theme/tokens.js');
  const { permissionTone } = await import('../src/tui/components/statusline.js');
  const palette = theme({ COLORTERM: 'truecolor' });
  const base = { session: { mode: 'build', permission: 'ask' } } as never;
  const withPermission = (mode: string, permission: string): never =>
    ({ session: { mode, permission } }) as never;

  assert.equal(permissionTone(base, palette).color, palette.muted, 'the safe default reads quietly');
  assert.equal(permissionTone(withPermission('build', 'acceptEdits'), palette).color, palette.warn);
  assert.equal(permissionTone(withPermission('build', 'bypass'), palette).color, palette.error);
  assert.equal(
    permissionTone(withPermission('crazy', 'ask'), palette).label, 'bypass',
    'crazy mode bypasses whatever the setting says, and the status line says so',
  );
});

test('the hints are two by default and grow only where a key would do something', async () => {
  const app = await mount({ columns: 100, rows: 30, run: () => new Promise(() => { /* running */ }) });
  await app.settle(60);
  const hintRow = (): string =>
    app.live().split('\n').map((line) => line.trim()).filter((line) => line !== '').at(-1) ?? '';
  assert.equal(
    hintRow().split('·').length, 2,
    `an idle composer offers the two hints that lead everywhere else, got "${hintRow()}"`,
  );
  assert.match(hintRow(), /Ctrl\+K commands/);
  assert.match(hintRow(), /Ctrl\+L views/);

  // Ctrl+T is offered once, and only once, there is output nobody has seen.
  await app.submit('go');
  await app.settle(40);
  assert.ok(!hintRow().includes('output'), 'nothing has run yet, so nothing is offered');
  app.emit({ type: 'tool_start', tool: 'read_file', input: { path: 'a.go' }, id: 'c1' });
  app.emit({ type: 'tool_result', tool: 'read_file', summary: '2 lines', detail: 'one\ntwo', id: 'c1', status: 'ok' });
  await app.settle(60);
  assert.match(hintRow(), /Ctrl\+T output/, 'now there is something to show');
  app.unmount();
});
