import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { createMastraEngine } from '../src/agent/mastraEngine.js';
import { mount } from './harness/tui.js';
import type { MastraEngine } from '../src/agent/mastraEngine.js';
import type { AgentMode } from '../src/types/index.js';

// --- minimal SSE gateway -----------------------------------------------------

interface Envelope { choices?: Array<{ finish_reason?: string; message?: Record<string, unknown> }> }

function toSSE(payload: Envelope): string {
  const out: string[] = [];
  for (const choice of payload.choices ?? []) {
    const m = choice.message ?? {};
    if (typeof m.content === 'string') out.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: m.content }, finish_reason: null }] })}`);
    if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) out.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: m.tool_calls }, finish_reason: null }] })}`);
    out.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason ?? 'stop' }] })}`);
  }
  out.push('data: [DONE]');
  return out.join('\n');
}

function chatServer(handler: (body: { messages: Array<{ role: string; content: unknown }> }) => Envelope) {
  const calls: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const server = http.createServer(async (req, res) => {
    const raw: Buffer[] = [];
    for await (const c of req) raw.push(Buffer.from(c));
    const body = JSON.parse(Buffer.concat(raw).toString());
    calls.push(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(toSSE(handler(body)));
  });
  server.listen(0);
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no bind');
  return { calls, url: `http://localhost:${addr.port}`, close: () => server.close() };
}

// --- 1. each mode shapes the system frame ----------------------------------

const MODE_MARKERS: Array<[AgentMode, RegExp, boolean]> = [
  ['plan', /You are in PLAN mode/, false],
  ['build', /You are in BUILD mode/, true], // build carries the WORK LOGIC discipline
  ['research', /You are in RESEARCH mode/, false],
  ['crazy', /You are in CRAZY MODE/, false],
];

for (const [mode, marker, hasWorkLogic] of MODE_MARKERS) {
  test(`${mode} mode: system frame carries its own instructions`, async () => {
    const live = chatServer(() => ({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] }));
    try {
      const engine = await createMastraEngine({ workspaceRoot: os.tmpdir(), endpoint: live.url, mode });
      await engine.run('hi');
      const system = live.calls[0].messages[0];
      assert.equal(system.role, 'system');
      assert.match(system.content, marker);
      if (hasWorkLogic) assert.match(system.content, /WORK LOGIC/);
      else assert.doesNotMatch(system.content, /WORK LOGIC/);
    } finally { live.close(); }
  });
}

test('every mode is told it is a tool and not a chat partner', async () => {
  // Without this the model answers "hi" the way a chat assistant does — a
  // greeting, an offer of further help, an exclamation mark — and no amount of
  // work on the interface around it makes that read as developer infrastructure.
  for (const mode of ['plan', 'build', 'research', 'crazy'] as AgentMode[]) {
    const live = chatServer(() => ({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] }));
    try {
      const engine = await createMastraEngine({ workspaceRoot: os.tmpdir(), endpoint: live.url, mode });
      await engine.run('hi');
      const system = live.calls[0].messages[0].content;
      assert.match(system, /VOICE/, `${mode} carries the voice rules`);
      assert.match(system, /Never greet/, `${mode} forbids the greeting`);
      assert.match(system, /No emoji/, `${mode} forbids emoji`);
      assert.match(system, /Never list your own capabilities/, `${mode} forbids the capability list`);
      assert.match(system, /What's on your mind/, `${mode} carries the worked counter-example`);
      // Voice leads. Buried behind the work discipline it was the first thing
      // the model dropped, and a harness that answers "hi" with a capability
      // list is not a harness however good the terminal around it looks.
      // "You are in PLAN mode" / "You are in CRAZY MODE" — the marker every
      // mode shares, and the one thing the voice has to come before.
      const modeAt = system.indexOf('You are in ');
      assert.ok(modeAt > 0, `${mode} states its mode`);
      assert.ok(
        system.indexOf('VOICE') < modeAt,
        `${mode} states the voice before the mode instructions`,
      );
    } finally { live.close(); }
  }
});

// --- 2. approval gating differs: crazy auto-approves, the rest prompt -------

function writeThenStop(pathName: string): Envelope[] {
  return [
    { choices: [{ finish_reason: 'tool_calls', message: { content: '', tool_calls: [{ index: 0, id: 'w1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: pathName, content: 'data' }) } }] } }] },
    { choices: [{ finish_reason: 'stop', message: { content: 'done' } }] },
  ];
}

for (const mode of ['plan', 'build', 'research'] as AgentMode[]) {
  test(`${mode} mode: a high-risk tool goes through the approval gate`, async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), `oh-mode-${mode}-`));
    const responses = writeThenStop('made.txt');
    const live = chatServer(() => responses.shift() ?? { choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] });
    try {
      const engine = await createMastraEngine({ workspaceRoot: ws, endpoint: live.url, mode });
      let prompted = 0;
      engine.setApprovalHandler(async () => { prompted += 1; return { approved: false }; });
      await engine.run('write a file');
      assert.equal(prompted, 1, 'the approval handler was consulted');
      await assert.rejects(fs.readFile(path.join(ws, 'made.txt')), 'denied write never hit disk');
    } finally { live.close(); await fs.rm(ws, { recursive: true, force: true }); }
  });
}

test('crazy mode: high-risk tools are auto-approved (handler never consulted)', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'oh-mode-crazy-'));
  const responses = writeThenStop('auto.txt');
  const live = chatServer(() => responses.shift() ?? { choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] });
  try {
    const engine = await createMastraEngine({ workspaceRoot: ws, endpoint: live.url, mode: 'crazy' });
    let prompted = 0;
    engine.setApprovalHandler(async () => { prompted += 1; return { approved: false }; });
    await engine.run('write a file');
    assert.equal(prompted, 0, 'crazy mode skips the approval gate');
    assert.equal(await fs.readFile(path.join(ws, 'auto.txt'), 'utf8'), 'data');
  } finally { live.close(); await fs.rm(ws, { recursive: true, force: true }); }
});

// --- 2b. permission mode is an axis independent of the working mode -------

function writeThenRunThenStop(): Envelope[] {
  return [
    { choices: [{ finish_reason: 'tool_calls', message: { content: '', tool_calls: [{ index: 0, id: 'w1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'edit.txt', content: 'x' }) } }] } }] },
    { choices: [{ finish_reason: 'tool_calls', message: { content: '', tool_calls: [{ index: 0, id: 'r1', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'echo hi' }) } }] } }] },
    { choices: [{ finish_reason: 'stop', message: { content: 'done' } }] },
  ];
}

test('permissionMode "acceptEdits": file edits are waived, commands still prompt', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'oh-perm-edits-'));
  const responses = writeThenRunThenStop();
  const live = chatServer(() => responses.shift() ?? { choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] });
  try {
    const engine = await createMastraEngine({ workspaceRoot: ws, endpoint: live.url, mode: 'build', permissionMode: 'acceptEdits', shellAllowed: true });
    const gated: string[] = [];
    engine.setApprovalHandler(async (a) => { gated.push(a.tool); return { approved: false }; });
    await engine.run('edit then run');
    assert.deepEqual(gated, ['run_command'], 'only the command hit the gate');
    assert.equal(await fs.readFile(path.join(ws, 'edit.txt'), 'utf8'), 'x', 'the edit was auto-approved');
  } finally { live.close(); await fs.rm(ws, { recursive: true, force: true }); }
});

test('permissionMode "bypass": nothing hits the approval gate', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'oh-perm-bypass-'));
  const responses = writeThenRunThenStop();
  const live = chatServer(() => responses.shift() ?? { choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] });
  try {
    const engine = await createMastraEngine({ workspaceRoot: ws, endpoint: live.url, mode: 'build', permissionMode: 'bypass', shellAllowed: true });
    let prompted = 0;
    engine.setApprovalHandler(async () => { prompted += 1; return { approved: false }; });
    await engine.run('edit then run');
    assert.equal(prompted, 0);
    assert.equal(await fs.readFile(path.join(ws, 'edit.txt'), 'utf8'), 'x');
  } finally { live.close(); await fs.rm(ws, { recursive: true, force: true }); }
});

// --- 3. the swarm fan-out is crazy-only, and the client decides when ------
//
// Fanning a plan out is a session decision, not a model one: the harness owns
// how a worker behaves, the client owns whether to ask for several. These
// checks pin that decision to crazy mode, so no other mode can silently start
// spending three times as much.

for (const mode of ['plan', 'build', 'research'] as AgentMode[]) {
  test(`${mode} mode: a multi-step plan does NOT fan out`, async () => {
    const app = await mount({
      mode,
      taskQueue: [
        { id: 'a', title: 'one', status: 'pending' },
        { id: 'b', title: 'two', status: 'pending' },
      ],
    });
    await app.submit('do the work');
    await app.settle(150);
    assert.equal(app.calls.swarms, 0, `${mode} never fans out`);
    app.unmount();
  });
}

test('crazy mode: a multi-step plan fans out exactly once', async () => {
  const app = await mount({
    mode: 'crazy',
    taskQueue: [
      { id: 'a', title: 'one', status: 'pending' },
      { id: 'b', title: 'two', status: 'pending' },
    ],
  });
  await app.submit('do the work');
  await app.settle(200);
  assert.equal(app.calls.swarms, 1, 'crazy fans out once the plan has two or more pending steps');
  app.unmount();
});

test('crazy mode: a single-step plan is finished in one pass rather than fanned out', async () => {
  const app = await mount({
    mode: 'crazy',
    taskQueue: [{ id: 'a', title: 'the only step', status: 'pending' }],
  });
  await app.submit('do the work');
  await app.settle(200);
  assert.equal(app.calls.swarms, 0, 'spinning up workers for one step costs more than it saves');
  app.unmount();
});
