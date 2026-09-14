import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ingest, targetFor, verbFor } from '../src/tui/runtime/ingest.js';
import type { HarnessEvent } from '../src/agent/mastraEngine.js';

const at = 1000;
const one = (event: HarnessEvent): ReturnType<typeof ingest>[number] | undefined => ingest(event, at)[0];

test('a tool call names what it is acting on', () => {
  const action = one({ type: 'tool_start', tool: 'read_file', input: { path: 'gateway/fallback.go' }, id: 'c1' });
  assert.ok(action?.type === 'tool/start');
  assert.equal(action.verb, 'read');
  assert.equal(action.target, 'gateway/fallback.go');
  assert.equal(action.id, 'c1');
});

test('a shell call shows the command, not the tool name', () => {
  const action = one({ type: 'tool_start', tool: 'run_command', input: { command: 'go test ./...' }, id: 'c2' });
  assert.ok(action?.type === 'tool/start');
  assert.equal(action.verb, '$');
  assert.equal(action.target, 'go test ./...');
});

test('a tool whose arguments name no subject gets no invented one', () => {
  for (const input of [undefined, null, 42, 'text', {}, { unrelated: 1 }, { path: '   ' }]) {
    assert.equal(targetFor(input), '', `no target for ${JSON.stringify(input) ?? 'undefined'}`);
  }
});

test('an unknown tool keeps its own name rather than being given a friendly lie', () => {
  assert.equal(verbFor('some_future_tool'), 'some_future_tool');
});

test('an engine that emits no call id still pairs its start and result', () => {
  const start = one({ type: 'tool_start', tool: 'git_diff', input: {} });
  const end = one({ type: 'tool_result', tool: 'git_diff', summary: '2 files' });
  assert.ok(start?.type === 'tool/start' && end?.type === 'tool/end');
  assert.equal(start.id, end.id);
});

test('a result with no status is treated as success, and an explicit one is honoured', () => {
  const silent = one({ type: 'tool_result', tool: 'read_file', summary: 'ok' });
  assert.ok(silent?.type === 'tool/end' && silent.outcome === 'ok');
  const denied = one({ type: 'tool_result', tool: 'run_command', summary: 'no', status: 'denied' });
  assert.ok(denied?.type === 'tool/end' && denied.outcome === 'denied');
});

test('a worker\'s narrative goes to its lane, not into the main answer', () => {
  assert.deepEqual(ingest({ type: 'text_delta', delta: 'chunk', agentId: 'A2' }, at), []);
  const action = one({ type: 'text', content: 'built the parser\nand tested it', agentId: 'A2' });
  assert.ok(action?.type === 'agent/update');
  assert.equal(action.id, 'A2');
  assert.equal(action.note, 'built the parser');
});

test('the main answer still streams into the live region', () => {
  const action = one({ type: 'text_delta', delta: 'hello' });
  assert.ok(action?.type === 'stream/answer');
  assert.equal(action.delta, 'hello');
});

test('compression is reported only when the gateway actually saved something', () => {
  const none = one({
    type: 'text', content: 'x',
    compression: { ratio: 1, strategy: 'none', inputTokens: 10, compressedTokens: 10, savedTokens: 0 },
  });
  assert.ok(none?.type === 'stream/answerDone');
  assert.equal(none.compression, undefined);

  const saved = one({
    type: 'text', content: 'x',
    compression: { ratio: 0.6, strategy: 'rtk', inputTokens: 100, compressedTokens: 60, savedTokens: 40 },
  });
  assert.ok(saved?.type === 'stream/answerDone');
  assert.equal(saved.compression?.savedTokens, 40);
  assert.ok(Math.abs((saved.compression?.savedFraction ?? 0) - 0.4) < 1e-9);
});

test('a route event carries only the fields the gateway stated', () => {
  const bare = one({ type: 'route', fallback: false, attempts: 0 });
  assert.ok(bare?.type === 'route/observed');
  assert.deepEqual(Object.keys(bare.decision).sort(), ['at', 'attempts', 'fallback']);

  const full = one({
    type: 'route', fallback: true, attempts: 2, provider: 'anthropic',
    model: 'claude-sonnet-4-6', strategy: 'coding:reliable', latencyMs: 812, reason: '429',
  });
  assert.ok(full?.type === 'route/observed');
  assert.equal(full.decision.model, 'claude-sonnet-4-6');
  assert.equal(full.decision.latencyMs, 812);
});

test('an approval event produces no action — the handler owns the pending gate', () => {
  assert.deepEqual(ingest({ type: 'approval_requested', tool: 'run_command', input: {} }, at), []);
});

test('a plan is copied rather than aliased, so a later engine mutation cannot rewrite history', () => {
  const todos = [{ id: '1', title: 'a', status: 'pending' as const }];
  const action = one({ type: 'todos', todos });
  assert.ok(action?.type === 'plan/set');
  todos[0]!.title = 'changed';
  assert.equal(action.steps[0]?.title, 'a');
});

test('every event shape the engine can emit is handled without throwing', () => {
  const events: HarnessEvent[] = [
    { type: 'thinking', text: '' },
    { type: 'thinking_delta', delta: '' },
    { type: 'text_delta', delta: '' },
    { type: 'text', content: '' },
    { type: 'tool_start', tool: 't', input: undefined },
    { type: 'tool_result', tool: 't', summary: '' },
    { type: 'approval_requested', tool: 't', input: {} },
    { type: 'route', fallback: false, attempts: 0 },
    { type: 'preview', url: 'http://localhost:3000' },
    { type: 'attach', name: 'a.png', kind: 'image', size: 12 },
    { type: 'agent', id: 'A1', label: 'A1', status: 'spawned' },
    { type: 'todos', todos: [] },
  ];
  for (const event of events) assert.doesNotThrow(() => ingest(event, at));
});
