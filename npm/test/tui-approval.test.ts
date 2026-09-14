import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mount } from './harness/tui.js';
import type { ApprovalAction } from '../src/agent/mastraEngine.js';

const gate = (): ApprovalAction => ({
  tool: 'run_command',
  input: { command: 'rm -rf build' },
  scopes: [
    { id: 'cmd:exact:rm -rf build', label: 'always run exactly: rm -rf build' },
    { id: 'tool:run_command', label: 'always run any command' },
  ],
});

test('an approval names the tool and the exact call, and cannot be missed', async () => {
  const app = await mount({ columns: 100 });
  const pending = app.requestApproval(gate());
  await app.settle(60);
  const screen = app.screen();
  assert.match(screen, /approval needed/);
  assert.match(screen, /run_command/);
  assert.match(screen, /rm -rf build/);
  assert.match(screen, /always run exactly/);
  assert.match(screen, /y allow once/);
  await app.type('n');
  await pending;
  app.unmount();
});

test('the status line says the harness is waiting on a person', async () => {
  const app = await mount({ columns: 100 });
  const pending = app.requestApproval(gate());
  await app.settle(60);
  assert.match(app.screen(), /waiting for you/);
  await app.type('n');
  await pending;
  app.unmount();
});

test('y allows once and grants no standing trust', async () => {
  const app = await mount({ columns: 100 });
  const pending = app.requestApproval(gate());
  await app.settle(60);
  await app.type('y');
  assert.deepEqual(await pending, { approved: true });
  app.unmount();
});

test('n denies', async () => {
  const app = await mount({ columns: 100 });
  const pending = app.requestApproval(gate());
  await app.settle(60);
  await app.type('n');
  assert.deepEqual(await pending, { approved: false });
  app.unmount();
});

test('enter allows and escape denies, so neither answer needs a mouse or a manual', async () => {
  const allow = await mount({ columns: 100 });
  const allowed = allow.requestApproval(gate());
  await allow.settle(60);
  await allow.type('\r');
  assert.deepEqual(await allowed, { approved: true });
  allow.unmount();

  const deny = await mount({ columns: 100 });
  const denied = deny.requestApproval(gate());
  await deny.settle(60);
  await deny.type('\x1b');
  assert.deepEqual(await denied, { approved: false });
  deny.unmount();
});

test('a digit picks the trust scope it is numbered with', async () => {
  const app = await mount({ columns: 100 });
  const pending = app.requestApproval(gate());
  await app.settle(60);
  await app.type('2');
  assert.deepEqual(await pending, { approved: true, trust: 'tool:run_command' });
  app.unmount();
});

test('"a" takes the most specific scope, which is the first one offered', async () => {
  const app = await mount({ columns: 100 });
  const pending = app.requestApproval(gate());
  await app.settle(60);
  await app.type('a');
  assert.deepEqual(await pending, { approved: true, trust: 'cmd:exact:rm -rf build' });
  app.unmount();
});

test('a digit past the end of the list is not an answer', async () => {
  const app = await mount({ columns: 100 });
  const pending = app.requestApproval(gate());
  await app.settle(60);
  await app.type('7');
  await app.settle(40);
  assert.match(app.screen(), /approval needed/, 'still waiting');
  await app.type('n');
  await pending;
  app.unmount();
});

test('nothing typed at the composer can resolve a gate by accident', async () => {
  const app = await mount({ columns: 100 });
  const pending = app.requestApproval(gate());
  await app.settle(60);
  await app.type('some words about the task');
  await app.settle(40);
  assert.match(app.screen(), /approval needed/, 'the gate is still open');
  const rows = app.screen().split('\n');
  assert.ok(!rows.some((line) => line.includes('some words about the task')), 'and nothing was typed into the composer');
  await app.type('n');
  await pending;
  app.unmount();
});

test('unmounting denies a pending approval instead of leaving the engine blocked forever', async () => {
  const app = await mount({ columns: 100 });
  const pending = app.requestApproval(gate());
  await app.settle(60);
  app.unmount();
  assert.deepEqual(await pending, { approved: false });
});

test('the approval banner still fits, and still shouts, on a narrow terminal', async () => {
  const app = await mount({ columns: 52, rows: 20 });
  const pending = app.requestApproval(gate());
  await app.settle(60);
  try {
    const screen = app.screen();
    assert.match(screen, /approval needed/);
    assert.match(screen, /rm -rf build/);
    for (const line of screen.split('\n')) assert.ok(line.length <= 52, JSON.stringify(line));
  } finally {
    await app.type('n');
    await pending;
    app.unmount();
  }
});

test('a run continues after the gate is answered', async () => {
  const app = await mount({ columns: 100, run: () => new Promise<never>(() => { /* running */ }) });
  await app.submit('go');
  app.emit({ type: 'tool_start', tool: 'run_command', input: { command: 'rm -rf build' }, id: 'c1' });
  const pending = app.requestApproval(gate());
  await app.settle(60);
  await app.type('y');
  await pending;
  app.emit({ type: 'tool_result', tool: 'run_command', summary: 'exit 0', id: 'c1', status: 'ok' });
  await app.settle(60);
  const screen = app.screen();
  assert.ok(!screen.split('\n').at(-4)?.includes('approval needed'), 'the banner is gone');
  assert.match(screen, /exit 0/);
  app.unmount();
});
