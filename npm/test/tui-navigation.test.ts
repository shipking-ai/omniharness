import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { mount } from './harness/tui.js';

const CTRL_K = '\x0b';
const CTRL_L = '\x0c';
const CTRL_E = '\x05';
const CTRL_O = '\x0f';
const CTRL_C = '\x03';
const BACKTAB = '\x1b[Z';
const ESC = '\x1b';
const DOWN = '\x1b[B';

// --- composer --------------------------------------------------------------

test('the composer takes multiple lines and Ctrl+J is the newline', async () => {
  const app = await mount({ columns: 100 });
  await app.type('first');
  await app.type('\x0a'); // Ctrl+J
  await app.type('second');
  const screen = app.screen();
  assert.match(screen, /first[\s\S]*second/);
  assert.ok(!screen.includes('firstsecond'), 'the two lines are not concatenated');
  assert.deepEqual(app.calls.runs, [], 'a newline does not submit');
  app.unmount();
});

test('a pasted block lands in the composer as one edit', async () => {
  const app = await mount({ columns: 100 });
  await app.type('line one\r\nline two');
  const screen = app.screen();
  assert.match(screen, /line one[\s\S]*line two/);
  assert.deepEqual(app.calls.runs, [], 'a carriage return inside a paste is not a submit');
  app.unmount();
});

test('the up arrow recalls the previous prompt and it can be sent again', async () => {
  const app = await mount({ columns: 100 });
  await app.submit('the first task');
  await app.settle(120);
  await app.type('\x1b[A'); // up
  await app.settle(40);
  assert.match(app.screen(), /the first task/);
  await app.submit('');
  assert.deepEqual(app.calls.runs, ['the first task', 'the first task']);
  app.unmount();
});

test('a prompt typed during a run is queued, then sent when the run ends', async () => {
  let finish: (() => void) | undefined;
  const app = await mount({
    columns: 100,
    run: () => new Promise((resolve) => { finish = () => resolve({ content: 'ok', model: 'm' }); }),
  });
  await app.submit('first');
  await app.submit('second');
  assert.deepEqual(app.calls.runs, ['first'], 'the second prompt did not start a run of its own');
  assert.match(app.screen(), /queued/);

  finish?.();
  await app.settle(160);
  assert.deepEqual(app.calls.runs, ['first', 'second']);
  app.unmount();
});

test('Ctrl+C cancels a run in flight and quits when nothing is running', async () => {
  const app = await mount({ columns: 100, run: () => new Promise<never>(() => { /* running */ }) });
  await app.submit('go');
  await app.type(CTRL_C);
  assert.equal(app.calls.cancels, 1);
  assert.match(app.screen(), /cancelling/);
  app.unmount();
});

// --- modes and permissions -------------------------------------------------

test('Ctrl+E cycles the working mode and tells the engine', async () => {
  const app = await mount({ columns: 100, mode: 'plan' });
  for (const expected of ['build', 'research', 'crazy', 'plan']) {
    await app.type(CTRL_E);
    assert.match(app.screen(), new RegExp(`mode → ${expected}`), `cycled to ${expected}`);
  }
  assert.equal((app.engine.state as { mode: string }).mode, 'plan', 'the engine came full circle too');
  app.unmount();
});

test('Shift+Tab cycles how approvals are handled', async () => {
  const app = await mount({ columns: 100, mode: 'build' });
  for (const expected of ['accept edits', 'bypass', 'manual']) {
    await app.type(BACKTAB);
    assert.match(app.screen(), new RegExp(`permissions → ${expected}`), `cycled to ${expected}`);
  }
  assert.equal((app.engine.state as { permissionMode: string }).permissionMode, 'ask');
  app.unmount();
});

test('crazy mode reports bypass however the permission setting is left', async () => {
  const app = await mount({ columns: 100, mode: 'crazy', permissionMode: 'ask' });
  // The status line is the middle of the three chrome rows that close a frame.
  const rows = app.live().split('\n').map((line) => line.trim()).filter((line) => line !== '');
  const status = rows.at(-2) ?? '';
  assert.match(status, /bypass/, 'the status line does not claim approvals are still being asked for');
  app.unmount();
});

// --- palette ---------------------------------------------------------------

test('the palette opens, filters, and runs what is chosen', async () => {
  const app = await mount({ columns: 100, rows: 40 });
  await app.type(CTRL_K);
  assert.match(app.screen(), /commands/);
  assert.match(app.screen(), /Choose an engine/);

  await app.type('mode cra');
  await app.settle(40);
  const filtered = app.screen();
  assert.match(filtered, /Switch to crazy mode/);
  assert.ok(!filtered.slice(filtered.lastIndexOf('mode cra')).includes('Choose an engine'), 'the list narrowed');

  await app.type('\r');
  await app.settle(40);
  assert.match(app.screen(), /mode → crazy/);
  app.unmount();
});

test('a palette command that needs an argument opens in the composer instead of running empty', async () => {
  const app = await mount({ columns: 100, rows: 40 });
  await app.type(CTRL_K);
  await app.type('save');
  await app.settle(40);
  await app.type('\r');
  await app.settle(40);
  assert.match(app.screen(), /\/save/);
  app.unmount();
});

test('escape closes the palette and gives the keyboard back to the composer', async () => {
  const app = await mount({ columns: 100, rows: 40 });
  await app.type(CTRL_K);
  await app.type(ESC);
  await app.settle(40);
  await app.type('typing again');
  assert.match(app.screen(), /typing again/);
  app.unmount();
});

test('every command is also reachable by typing its name', async () => {
  const app = await mount({ columns: 100 });
  await app.submit('/mode research');
  assert.match(app.screen(), /mode → research/);
  app.unmount();
});

test('an unknown command names the typo and points at the palette', async () => {
  const app = await mount({ columns: 100 });
  await app.submit('/rout');
  assert.match(app.screen(), /unknown command '\/rout'/);
  assert.match(app.screen(), /Ctrl\+K/);
  assert.deepEqual(app.calls.runs, [], 'a mistyped command is not sent to the model as a prompt');
  app.unmount();
});

test('typing a slash offers the commands it could become', async () => {
  const app = await mount({ columns: 100 });
  await app.type('/se');
  await app.settle(40);
  assert.match(app.screen(), /\/sessions/);
  app.unmount();
});

test('tab completes the first offered command', async () => {
  const app = await mount({ columns: 100 });
  await app.type('/rou');
  await app.type('\t');
  await app.settle(40);
  assert.match(app.screen(), /\/route/);
  app.unmount();
});

// --- engine picker ---------------------------------------------------------

test('Ctrl+O lists the engines OmniRoute offers and selecting one saves it', async () => {
  const app = await mount({
    columns: 100, rows: 40,
    combos: [{ name: 'my-combo', strategy: 'cheapest', models: [] }],
    catalog: [{ id: 'auto/coding' }, { id: 'auto/fast' }, { id: 'cc/claude-sonnet-4-6' }],
  });
  await app.type(CTRL_O);
  await app.settle(80);
  const screen = app.screen();
  assert.match(screen, /your combos/);
  assert.match(screen, /my-combo/);
  assert.match(screen, /auto engines/);
  assert.match(screen, /auto\/fast/);
  assert.ok(!screen.includes('cc/claude-sonnet-4-6'), 'a bare upstream model is not an engine you pick here');

  assert.match(screen, /auto\/coding.*current/, 'the list opens on the engine already in use');

  await app.type(DOWN);
  await app.type('\r');
  await app.settle(60);
  assert.deepEqual(app.calls.models, ['auto/fast'], 'one step down from the current engine');
  app.unmount();
});

test('an unreachable gateway says so instead of showing an empty list', async () => {
  const app = await mount({ columns: 100, rows: 40, catalogError: new Error('connection refused') });
  await app.type(CTRL_O);
  await app.settle(100);
  assert.match(app.screen(), /connection refused/);
  assert.match(app.screen(), /check that OmniRoute is running/);
  app.unmount();
});

// --- lenses ----------------------------------------------------------------

test('Ctrl+L walks the lenses and comes back to the run view', async () => {
  const app = await mount({ columns: 100, rows: 40 });
  for (const expected of [/agents/, /plan/, /route/, /sessions/]) {
    await app.type(CTRL_L);
    await app.settle(40);
    assert.match(app.screen(), expected);
  }
  await app.type(CTRL_L);
  await app.settle(40);
  await app.type('back at the composer');
  assert.match(app.screen(), /back at the composer/);
  app.unmount();
});

test('the agents lens explains itself when nothing is running in parallel', async () => {
  const app = await mount({ columns: 100, rows: 40 });
  await app.type(CTRL_L);
  await app.settle(40);
  assert.match(app.screen(), /no parallel workers/);
  app.unmount();
});

test('the agents lens lists every worker with its state and lets one be selected', async () => {
  const app = await mount({ columns: 100, rows: 40, run: () => new Promise<never>(() => { /* running */ }) });
  await app.submit('go');
  app.emit({ type: 'agent', id: 'A1', label: 'A1', status: 'working', note: 'writing the parser' });
  app.emit({ type: 'agent', id: 'A2', label: 'A2', status: 'done', note: 'ran the tests' });
  app.emit({ type: 'agent', id: 'A3', label: 'A3', status: 'error', note: 'build failed' });
  await app.type(CTRL_L);
  await app.settle(60);
  const screen = app.screen();
  assert.match(screen, /1 working/);
  assert.match(screen, /1 done/);
  assert.match(screen, /1 failed/);
  assert.match(screen, /writing the parser/);
  assert.match(screen, /build failed/);

  app.emit({ type: 'tool_start', tool: 'write_file', input: { path: 'parser.go' }, id: 'c1', agentId: 'A1' });
  app.emit({ type: 'tool_result', tool: 'write_file', summary: 'wrote 40 lines', id: 'c1', agentId: 'A1', status: 'ok' });
  await app.settle(60);
  assert.match(app.screen(), /A1 · recent calls/);
  assert.match(app.screen(), /parser\.go/);
  app.unmount();
});

test('the plan lens shows the whole plan and what is blocked', async () => {
  const app = await mount({ columns: 100, rows: 40, run: () => new Promise<never>(() => { /* running */ }) });
  await app.submit('go');
  app.emit({ type: 'todos', todos: Array.from({ length: 9 }, (_, i) => ({
    id: String(i), title: `step number ${i}`, status: i < 3 ? 'done' : i === 3 ? 'active' : 'pending',
  })) });
  app.emit({ type: 'tool_start', tool: 'run_command', input: { command: 'go vet ./...' }, id: 'c1' });
  app.emit({ type: 'tool_result', tool: 'run_command', summary: 'exit 2', id: 'c1', status: 'error' });
  await app.type(CTRL_L);
  await app.type(CTRL_L);
  await app.settle(60);
  const screen = app.screen();
  assert.match(screen, /3\/9 done/);
  assert.match(screen, /step number 8/, 'the whole plan is here, not the three-row digest');
  assert.match(screen, /blocked/);
  assert.match(screen, /go vet/);
  app.unmount();
});

// --- sessions --------------------------------------------------------------

test('the sessions lens lists snapshots and enter resumes the selected one', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omniharness-sessions-'));
  try {
    const dir = path.join(root, '.omniharness', 'sessions');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'yesterday.json'), JSON.stringify({
      savedAt: new Date().toISOString(),
      taskQueue: [{ id: '1', title: 'a restored step', status: 'pending' }],
      messages: [
        { role: 'user', content: 'a question from yesterday', createdAt: new Date().toISOString() },
        { role: 'assistant', content: 'an answer from yesterday', createdAt: new Date().toISOString() },
      ],
    }), 'utf8');

    const app = await mount({ columns: 100, rows: 40, workspace: root });
    await app.settle(80);
    await app.submit('/sessions');
    await app.settle(80);
    assert.match(app.screen(), /yesterday/);

    await app.type('\r');
    await app.settle(120);
    const screen = app.screen();
    assert.match(screen, /resumed yesterday/);
    assert.match(screen, /a question from yesterday/);
    assert.match(screen, /an answer from yesterday/);
    assert.equal(app.engine.state.messages.length, 2, 'the engine resumed too');
    app.unmount();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a workspace with no snapshots says so rather than showing an empty list', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omniharness-empty-'));
  try {
    const app = await mount({ columns: 100, rows: 40, workspace: root });
    await app.submit('/sessions');
    await app.settle(80);
    assert.match(app.screen(), /no saved sessions in this workspace/);
    app.unmount();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('/save without a name asks for one instead of writing a nameless snapshot', async () => {
  const app = await mount({ columns: 100 });
  await app.submit('/save');
  await app.settle(40);
  assert.match(app.screen(), /\/save needs a name/);
  app.unmount();
});

test('/clear resets the view and the engine history', async () => {
  const app = await mount({ columns: 100 });
  await app.submit('a question');
  await app.settle(120);
  await app.submit('/clear');
  await app.settle(120);
  assert.equal(app.calls.cleared, 1);
  app.unmount();
});

test('/attach stages files for the next prompt rather than starting a turn of its own', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omniharness-attach-'));
  try {
    await writeFile(path.join(root, 'notes.txt'), 'some notes', 'utf8');
    const app = await mount({ columns: 100, workspace: root });
    await app.submit('/attach notes.txt');
    await app.settle(120);
    assert.match(app.screen(), /attached notes\.txt/);
    assert.match(app.screen(), /sent with your next prompt/);
    assert.deepEqual(app.calls.runs, [], 'attaching is not a turn');
    assert.deepEqual(app.calls.attached, ['notes.txt']);
    app.unmount();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('/find reports how many matches there are and shows the newest', async () => {
  const app = await mount({ columns: 100 });
  await app.submit('the provider fallback race');
  await app.settle(120);
  await app.submit('/find fallback');
  await app.settle(80);
  assert.match(app.screen(), /1 match for "fallback"/);

  await app.submit('/find nothing-like-this');
  await app.settle(80);
  assert.match(app.screen(), /no match for "nothing-like-this"/);
  app.unmount();
});

test('/skills reports what the session can reach, and the masthead no longer does', async () => {
  const app = await mount({ columns: 90, rows: 24 });
  // The opening screen is identity and workspace. A count that cannot change
  // during a session does not earn a permanent row on it.
  assert.ok(!app.screen().includes('skill'), 'the masthead says nothing about skills');

  await app.submit('/skills');
  await app.settle(60);
  assert.match(app.screen(), /built-in tools only/, 'and the command answers honestly when there are none');
  app.unmount();
});
