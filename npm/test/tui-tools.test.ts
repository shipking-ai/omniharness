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
  const rows = app.screen().split('\n').filter((line) => line.includes('go build'));
  assert.ok(rows.some((line) => line.trimStart().startsWith('x')), 'a failure carries the failure marker');
  assert.ok(rows.some((line) => line.includes('exit 1')));
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
