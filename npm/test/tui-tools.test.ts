import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mount } from './harness/tui.js';

const running = (): Promise<never> => new Promise<never>(() => { /* the run stays in flight */ });

test('a running call names the file it is reading, not the tool that reads it', async () => {
  const app = await mount({ columns: 100, run: running });
  await app.submit('go');
  app.emit({ type: 'tool_start', tool: 'read_file', input: { path: 'internal/gateway/fallback.go' }, id: 'c1' });
  await app.settle();
  const screen = app.screen();
  assert.match(screen, /read internal\/gateway\/fallback\.go/);
  assert.ok(!screen.includes('read_file'), 'the internal tool name is not what the reader needs');
  app.unmount();
});

test('a shell call shows the command it is about to run', async () => {
  const app = await mount({ columns: 100, run: running });
  await app.submit('go');
  app.emit({ type: 'tool_start', tool: 'run_command', input: { command: 'go test ./...' }, id: 'c1' });
  await app.settle();
  assert.match(app.screen(), /\$ go test \.\/\.\.\./);
  app.unmount();
});

test('a finished call keeps its summary and how long it took', async () => {
  const app = await mount({ columns: 100, run: running });
  await app.submit('go');
  app.emit({ type: 'tool_start', tool: 'read_file', input: { path: 'a.go' }, id: 'c1' });
  await app.settle(20);
  app.emit({ type: 'tool_result', tool: 'read_file', summary: '240 lines', detail: 'x', id: 'c1', status: 'ok' });
  await app.settle();
  assert.match(app.screen(), /read a\.go\s+240 lines/);
  app.unmount();
});

test('a failed call is immediately recognisable', async () => {
  const app = await mount({ columns: 100, run: running });
  await app.submit('go');
  app.emit({ type: 'tool_start', tool: 'run_command', input: { command: 'go build ./...' }, id: 'c1' });
  app.emit({
    type: 'tool_result', tool: 'run_command', summary: 'exit 1',
    detail: 'undefined: Foo', id: 'c1', status: 'error',
  });
  await app.settle();
  const screen = app.screen();
  const rows = screen.split('\n').filter((line) => line.includes('go build'));
  assert.ok(rows.some((line) => line.trimStart().startsWith('✗')), 'a failure carries the failure marker');
  assert.ok(rows.some((line) => line.includes('exit 1')));
  assert.match(screen, /undefined: Foo/, 'a failure shows its output without being asked for it');
  app.unmount();
});

test('a successful call keeps its output to itself until it is asked for', async () => {
  const app = await mount({ columns: 100, run: running });
  await app.submit('go');
  app.emit({ type: 'tool_start', tool: 'run_command', input: { command: 'go build ./...' }, id: 'c1' });
  app.emit({
    type: 'tool_result', tool: 'run_command', summary: 'exit 0',
    detail: 'a lot of build output nobody asked to read', id: 'c1', status: 'ok',
  });
  await app.settle();
  assert.ok(!app.screen().includes('nobody asked to read'));
  app.unmount();
});

test('a one-line failure is not printed twice under itself', async () => {
  const app = await mount({ columns: 100, run: running });
  await app.submit('go');
  app.emit({ type: 'tool_start', tool: 'run_command', input: { command: 'rm x' }, id: 'c1' });
  app.emit({
    type: 'tool_result', tool: 'run_command', summary: 'error: shell execution is disabled by policy',
    detail: 'error: shell execution is disabled by policy', id: 'c1', status: 'error',
  });
  await app.settle();
  const hits = app.screen().split('\n').filter((line) => line.includes('shell execution is disabled'));
  assert.equal(hits.length, 1, 'the row already said it');
  app.unmount();
});

test('a denied call says it was denied rather than reporting an error', async () => {
  const app = await mount({ columns: 100, run: running });
  await app.submit('go');
  app.emit({ type: 'tool_start', tool: 'run_command', input: { command: 'rm -rf /' }, id: 'c1' });
  app.emit({
    type: 'tool_result', tool: 'run_command', summary: 'user denied this tool call',
    id: 'c1', status: 'denied',
  });
  await app.settle();
  assert.match(app.screen(), /denied/);
  app.unmount();
});

test('output is collapsed by default and Ctrl+T expands the newest call', async () => {
  const app = await mount({ columns: 100, rows: 40, run: running });
  await app.submit('go');
  app.emit({ type: 'tool_start', tool: 'read_file', input: { path: 'a.go' }, id: 'c1' });
  app.emit({
    type: 'tool_result', tool: 'read_file', summary: '2 lines',
    detail: 'FIRST_OUTPUT_LINE\nSECOND_OUTPUT_LINE', id: 'c1', status: 'ok',
  });
  await app.settle();
  assert.ok(!app.screen().includes('FIRST_OUTPUT_LINE'), 'output does not drown the answer by default');

  await app.type('\x14'); // Ctrl+T
  await app.settle();
  assert.match(app.screen(), /FIRST_OUTPUT_LINE/);
  assert.match(app.screen(), /SECOND_OUTPUT_LINE/);
  app.unmount();
});

test('two calls in flight at once are both shown, and each result finds its own call', async () => {
  const app = await mount({ columns: 100, run: running });
  await app.submit('go');
  app.emit({ type: 'tool_start', tool: 'read_file', input: { path: 'first.go' }, id: 'c1' });
  app.emit({ type: 'tool_start', tool: 'read_file', input: { path: 'second.go' }, id: 'c2' });
  await app.settle();
  assert.match(app.screen(), /first\.go/);
  assert.match(app.screen(), /second\.go/);

  app.emit({ type: 'tool_result', tool: 'read_file', summary: 'FIRST_DONE', id: 'c1', status: 'ok' });
  await app.settle();
  const rows = app.screen().split('\n');
  const settled = rows.filter((line) => line.includes('FIRST_DONE'));
  assert.ok(settled.length > 0, 'the result is shown');
  assert.ok(settled.every((line) => line.includes('first.go')), 'attached to the call that produced it');
  app.unmount();
});

test('tool history survives into the next run instead of being wiped by it', async () => {
  let finish: (() => void) | undefined;
  const app = await mount({
    columns: 100,
    run: () => new Promise((resolve) => { finish = () => resolve({ content: 'ok', model: 'm' }); }),
  });
  await app.submit('first task');
  app.emit({ type: 'tool_start', tool: 'read_file', input: { path: 'kept.go' }, id: 'c1' });
  app.emit({ type: 'tool_result', tool: 'read_file', summary: 'read it', id: 'c1', status: 'ok' });
  await app.settle();
  finish?.();
  await app.settle(120);

  await app.submit('second task');
  await app.settle(60);
  assert.match(app.screen(), /kept\.go/, 'the earlier call is still in scrollback');
  app.unmount();
});

test('a diff is rendered as a diff when a call returns one', async () => {
  const app = await mount({ columns: 100, rows: 40, run: running });
  await app.submit('go');
  app.emit({ type: 'tool_start', tool: 'git_diff', input: {}, id: 'c1' });
  app.emit({
    type: 'tool_result', tool: 'git_diff', summary: '1 file', id: 'c1', status: 'ok',
    detail: '--- a/x.go\n+++ b/x.go\n@@ -1 +1 @@\n-old line\n+new line',
  });
  await app.settle();
  await app.type('\x14');
  await app.settle();
  try {
    const screen = app.screen();
    assert.match(screen, /- old line/);
    assert.match(screen, /\+ new line/);
    assert.match(screen, /diff\s/, 'the row is labelled by what it did, not by the tool name');
  } finally {
    app.unmount();
  }
});

test('the transcript reads in the order the work happened', async () => {
  let finish: ((v: { content: string; model: string }) => void) | undefined;
  const app = await mount({ columns: 100, run: () => new Promise((resolve) => { finish = resolve; }) });
  await app.submit('why is it failing');
  app.emit({ type: 'text_delta', delta: 'Reading the manifest first.' });
  app.emit({ type: 'tool_start', tool: 'read_file', input: { path: 'package.json' }, id: 'c1' });
  app.emit({ type: 'tool_result', tool: 'read_file', summary: '18 lines', id: 'c1', status: 'ok' });
  app.emit({ type: 'text', content: 'The name field is wrong.', model: 'm' });
  finish?.({ content: 'The name field is wrong.', model: 'm' });
  await app.settle(150);

  const screen = app.screen();
  const order = ['why is it failing', 'Reading the manifest first.', 'read package.json', 'The name field is wrong.'];
  let at = -1;
  for (const marker of order) {
    const next = screen.indexOf(marker, at + 1);
    assert.ok(next > at, `"${marker}" is out of order — a call must never render after the answer it preceded`);
    at = next;
  }
  app.unmount();
});

test('plan bookkeeping is the plan, not six rows above it', async () => {
  const app = await mount({ columns: 100, run: () => new Promise<never>(() => { /* running */ }) });
  await app.submit('go');
  for (const [i, title] of ['first step', 'second step'].entries()) {
    app.emit({ type: 'tool_start', tool: 'update_todo', input: { action: 'add', title }, id: `c${i}` });
    app.emit({ type: 'tool_result', tool: 'update_todo', summary: `todo added: ${title}`, id: `c${i}`, status: 'ok' });
  }
  app.emit({ type: 'todos', todos: [
    { id: '1', title: 'first step', status: 'done' },
    { id: '2', title: 'second step', status: 'active' },
  ] });
  await app.settle(80);
  const screen = app.screen();
  assert.ok(!screen.includes('todo added'), 'the bookkeeping call is not a transcript row');
  assert.match(screen, /first step/, 'the plan it produced is');
  app.unmount();
});

test('a bookkeeping call that failed is still reported', async () => {
  const app = await mount({ columns: 100, run: () => new Promise<never>(() => { /* running */ }) });
  await app.submit('go');
  app.emit({
    type: 'tool_result', tool: 'update_todo', summary: 'error: no such todo',
    detail: 'error: no such todo', id: 'c1', status: 'error',
  });
  await app.settle(60);
  assert.match(app.screen(), /plan\s+error: no such todo/, 'a plan the harness failed to write is news');
  app.unmount();
});

test('showing output skips calls that have nothing left to say', async () => {
  const app = await mount({ columns: 100, rows: 40, run: () => new Promise<never>(() => { /* running */ }) });
  await app.submit('go');
  // A read with more in it than its row showed.
  app.emit({ type: 'tool_start', tool: 'read_file', input: { path: 'notes.md' }, id: 'c1' });
  app.emit({
    type: 'tool_result', tool: 'read_file', summary: 'alpha',
    detail: 'alpha\nbeta\ngamma', id: 'c1', status: 'ok',
  });
  // A newer failure whose whole output is the line the row already carried.
  app.emit({ type: 'tool_start', tool: 'run_command', input: { command: 'go test ./...' }, id: 'c2' });
  app.emit({
    type: 'tool_result', tool: 'run_command', summary: 'error: shell execution is disabled by policy',
    detail: 'error: shell execution is disabled by policy', id: 'c2', status: 'error',
  });
  await app.settle(80);

  await app.type('\x14'); // Ctrl+T
  await app.settle(80);
  const screen = app.screen();
  assert.match(screen, /output ·\s+read notes\.md/, 'it reached the call that had something to show');
  assert.match(screen, /gamma/);
  assert.equal(
    screen.split('\n').filter((line) => line.includes('shell execution is disabled')).length, 1,
    'the one-line failure was not printed a second time under itself',
  );

  await app.type('\x14');
  await app.settle(80);
  assert.match(app.screen(), /nothing left to show/);
  app.unmount();
});

test('a call whose summary already says the verb does not say it twice', async () => {
  const app = await mount({ columns: 100, run: running });
  await app.submit('go');
  // index_workspace returns "indexed N entries", which rendered as
  // "index  indexed 0 entries" — the verb and its own summary, stuttering.
  app.emit({ type: 'tool_start', tool: 'index_workspace', input: {}, id: 'c1' });
  app.emit({ type: 'tool_result', tool: 'index_workspace', summary: 'indexed 0 entries', id: 'c1', status: 'ok' });
  await app.settle();
  const row = app.screen().split('\n').find((line) => line.includes('indexed 0 entries')) ?? '';
  assert.ok(row !== '', 'the call is on screen');
  assert.ok(!/index\s+indexed/.test(row), `the verb is not repeated: ${JSON.stringify(row)}`);
  assert.match(row.trimStart(), /^[+✓]\s+indexed 0 entries/, 'the summary is the subject of the row');
  app.unmount();
});

test('a verb the summary does not restate is still shown', async () => {
  const app = await mount({ columns: 100, run: running });
  await app.submit('go');
  app.emit({ type: 'tool_start', tool: 'git_diff', input: {}, id: 'c1' });
  app.emit({ type: 'tool_result', tool: 'git_diff', summary: '3 files changed', id: 'c1', status: 'ok' });
  await app.settle();
  const row = app.screen().split('\n').find((line) => line.includes('3 files changed')) ?? '';
  assert.match(row, /diff/, 'a summary about something else keeps the verb that produced it');
  app.unmount();
});
