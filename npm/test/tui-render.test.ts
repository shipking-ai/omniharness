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
  assert.ok(!/\bplan\b/.test(screen.split('────')[0] ?? ''), 'no plan heading before there is a plan');
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
  const screen = app.screen();
  assert.match(screen, /via anthropic/, 'the settled reply names the provider that answered');
  assert.match(screen, /claude-sonnet-4-6/);
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
    } finally {
      app.unmount();
    }
  });
}

/** The status line is the row that reports the phase. */
const statusRow = (screen: string): string =>
  screen.split('\n').filter((line) => line.trimStart().startsWith('ready')).at(-1) ?? '';

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
  assert.ok(!before.includes('agents'), 'no rail headings before any work exists');

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
  const legacy = await mount({ columns: 100 });
  await legacy.settle(400);
  assert.match(legacy.screen(), /Ctrl\+J newline/);
  legacy.unmount();

  const kitty = await mount({ columns: 100, kitty: true });
  await kitty.settle(60);
  assert.match(kitty.screen(), /shift\+enter newline/);
  kitty.unmount();
});

test('unmounting stops the engine', async () => {
  const app = await mount({ columns: 100 });
  app.unmount();
  await app.settle(20);
  assert.ok(app.calls.stopped > 0);
});

// --- resilience -------------------------------------------------------------

test('a dropped connection is reported, and the next prompt still runs', async () => {
  let attempt = 0;
  const app = await mount({
    columns: 100,
    run: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('fetch failed: ECONNREFUSED 127.0.0.1:20128');
      return { content: 'back online', model: 'auto/coding' };
    },
  });
  await app.submit('first');
  await app.settle(150);
  assert.match(app.screen(), /ECONNREFUSED/);

  await app.submit('second');
  await app.settle(150);
  assert.deepEqual(app.calls.runs, ['first', 'second'], 'the interface is still usable after a failure');
  app.unmount();
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
