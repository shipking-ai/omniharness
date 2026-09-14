import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialState, reduce, resetIds } from '../src/tui/state/reducer.js';
import {
  agentProgress, contextUse, fallbackHistory, phaseLabel, planProgress,
  railHasContent, routeFields, routeSummary, toolHistory, usageFields,
} from '../src/tui/state/selectors.js';
import { TRANSCRIPT_LIMIT } from '../src/tui/state/types.js';
import type { Action } from '../src/tui/state/actions.js';
import type { AppState } from '../src/tui/state/types.js';

const session: AppState['session'] = {
  workspace: '/w', endpoint: 'http://localhost:20128', model: 'auto/coding',
  mode: 'build', permission: 'ask', version: '0.0.0',
  skills: 0, plugins: 0, mcpTools: 0, saved: [],
};
const terminal: AppState['terminal'] = { columns: 100, rows: 40, kitty: null };

const fresh = (): AppState => { resetIds(); return initialState(session, terminal); };
const run = (state: AppState, ...actions: readonly Action[]): AppState =>
  actions.reduce((current, action) => reduce(current, action), state);

// --- transcript ------------------------------------------------------------

test('a run appends the prompt and clears the composer', () => {
  const state = run(fresh(),
    { type: 'composer/set', value: 'fix it', cursor: 6 },
    { type: 'run/start', prompt: 'fix it', at: 1 });
  assert.equal(state.phase, 'preparing');
  assert.equal(state.composer.value, '');
  assert.deepEqual(state.transcript.map((entry) => entry.kind), ['user']);
});

test('an empty prompt does not create a transcript entry', () => {
  const state = run(fresh(), { type: 'run/start', prompt: '', at: 1 });
  assert.equal(state.transcript.length, 0);
});

test('streamed text lands in the live region and settles into the transcript once', () => {
  let state = run(fresh(),
    { type: 'stream/answer', delta: 'hel' },
    { type: 'stream/answer', delta: 'lo' });
  assert.equal(state.live.answer, 'hello');
  assert.equal(state.phase, 'streaming');
  assert.equal(state.transcript.length, 0, 'nothing settles while it is still streaming');

  state = reduce(state, { type: 'stream/answerDone', text: 'hello', at: 2, model: 'm' });
  assert.equal(state.live.answer, '');
  assert.deepEqual(state.transcript.map((entry) => entry.kind), ['assistant']);
});

test('an empty final answer settles nothing', () => {
  const state = run(fresh(), { type: 'stream/answerDone', text: '', at: 2 });
  assert.equal(state.transcript.length, 0);
});

test('the transcript is bounded so a long autonomous run cannot grow forever', () => {
  let state = fresh();
  for (let i = 0; i < TRANSCRIPT_LIMIT + 50; i += 1) {
    state = reduce(state, { type: 'notice', level: 'info', at: i, text: `n${i}` });
  }
  assert.equal(state.transcript.length, TRANSCRIPT_LIMIT);
  const last = state.transcript[state.transcript.length - 1];
  assert.ok(last?.kind === 'notice' && last.text === `n${TRANSCRIPT_LIMIT + 49}`, 'the newest entries survive');
});

// --- tools -----------------------------------------------------------------

const startTool = (id: string, name = 'read_file', at = 1): Action =>
  ({ type: 'tool/start', id, name, verb: name === 'run_command' ? '$' : 'read', target: `${id}.go`, at });

test('a finished call stays in the live region so its output can still be opened', () => {
  let state = run(fresh(), startTool('c1'));
  assert.equal(state.live.tools.length, 1);

  state = reduce(state, { type: 'tool/end', id: 'c1', outcome: 'ok', summary: '12 lines', at: 5 });
  const settled = state.live.tools[0];
  assert.equal(settled?.outcome, 'ok');
  assert.equal(settled?.endedAt, 5);
  assert.equal(state.transcript.length, 0, 'a row in scrollback can never be redrawn, so it waits');
});

test('the next run flushes the previous run\'s calls into scrollback', () => {
  const state = run(fresh(),
    startTool('c1'),
    { type: 'tool/end', id: 'c1', outcome: 'ok', summary: 'read it', at: 5 },
    { type: 'run/start', prompt: 'next task', at: 6 });
  assert.equal(state.live.tools.length, 0);
  assert.deepEqual(state.transcript.map((entry) => entry.kind), ['tool', 'user']);
});

test('enough finished calls spill into scrollback before the live region outgrows the viewport', () => {
  let state = fresh();
  for (let i = 0; i < 20; i += 1) {
    state = run(state,
      startTool(`c${i}`),
      { type: 'tool/end', id: `c${i}`, outcome: 'ok', at: i });
  }
  assert.ok(state.live.tools.length <= 12, `live region held ${state.live.tools.length}`);
  assert.ok(state.transcript.some((entry) => entry.kind === 'tool'), 'the rest went to scrollback');
});

test('interleaved calls are matched by id, not by arrival order', () => {
  let state = run(fresh(), startTool('c1'), startTool('c2', 'run_command'));
  state = reduce(state, { type: 'tool/end', id: 'c1', outcome: 'error', summary: 'boom', at: 6 });

  const [first, second] = state.live.tools;
  assert.equal(first?.id, 'c1');
  assert.equal(first?.outcome, 'error', 'the result belongs to the call that produced it');
  assert.equal(second?.id, 'c2');
  assert.equal(second?.outcome, 'running', 'the other call is untouched');
});

test('a result for a call that was never seen start is still recorded', () => {
  const state = run(fresh(), { type: 'tool/end', id: 'ghost', outcome: 'ok', summary: 'done', at: 3 });
  assert.equal(state.live.tools.length, 1);
  assert.equal(state.live.tools[0]?.outcome, 'ok');
});

test('a run that ends with a tool still open marks it failed rather than leaving it spinning', () => {
  const state = run(fresh(),
    { type: 'run/start', prompt: 'x', at: 1 },
    startTool('c1'),
    { type: 'run/end', at: 9 });
  assert.equal(state.live.tools[0]?.outcome, 'error');
  assert.equal(state.phase, 'idle');
});

test('expanding a tool toggles', () => {
  let state = run(fresh(), { type: 'tool/toggleExpanded', id: 'c1' });
  assert.deepEqual(state.expanded, ['c1']);
  state = reduce(state, { type: 'tool/toggleExpanded', id: 'c1' });
  assert.deepEqual(state.expanded, []);
});

// --- agents ----------------------------------------------------------------

test('an agent keeps its last note when a status-only update arrives', () => {
  let state = run(fresh(),
    { type: 'agent/update', id: 'A1', label: 'A1', status: 'working', note: 'compiling', at: 1 });
  state = reduce(state, { type: 'agent/update', id: 'A1', label: 'A1', status: 'done', at: 2 });
  assert.equal(state.agents[0]?.note, 'compiling');
  assert.equal(state.agents[0]?.startedAt, 1, 'the start time is not reset by an update');
});

test('agent progress counts spawned workers as still working', () => {
  const state = run(fresh(),
    { type: 'agent/update', id: 'A1', label: 'A1', status: 'spawned', at: 1 },
    { type: 'agent/update', id: 'A2', label: 'A2', status: 'done', at: 1 },
    { type: 'agent/update', id: 'A3', label: 'A3', status: 'error', at: 1 });
  assert.deepEqual(agentProgress(state), { total: 3, working: 1, done: 1, failed: 1 });
});

// --- routing and usage -----------------------------------------------------

test('an ordinary route decision is recorded but not written into the transcript', () => {
  const state = run(fresh(), {
    type: 'route/observed',
    decision: { at: 1, provider: 'openai', attempts: 0, fallback: false },
  });
  assert.equal(state.route.current?.provider, 'openai');
  assert.equal(state.transcript.length, 0, 'a normal route is not news');
});

test('a failover is written into the transcript beside the turn it affected', () => {
  const state = run(fresh(), {
    type: 'route/observed',
    decision: { at: 1, provider: 'anthropic', attempts: 1, fallback: true, reason: '429' },
  });
  assert.deepEqual(state.transcript.map((entry) => entry.kind), ['route']);
  assert.equal(fallbackHistory(state).length, 1);
});

test('route fields carry only what the gateway stated', () => {
  const bare = run(fresh(), {
    type: 'route/observed',
    decision: { at: 1, attempts: 0, fallback: false, provider: 'openai' },
  });
  const labels = routeFields(bare).map((field) => field.label);
  assert.deepEqual(labels, ['engine', 'provider'], 'no model, profile, latency or attempts were reported');
  assert.equal(routeSummary(bare), 'openai');
});

test('a route with nothing named at all produces no status summary', () => {
  const state = run(fresh(), {
    type: 'route/observed', decision: { at: 1, attempts: 0, fallback: false },
  });
  assert.equal(routeSummary(state), undefined);
});

test('usage rows are omitted entirely when nothing was measured', () => {
  assert.deepEqual(usageFields(fresh()), []);
  assert.equal(contextUse(fresh(), new Map()), undefined);
});

test('usage rows appear only for the figures that were measured', () => {
  const state = run(fresh(), { type: 'usage/set', usage: { tokensIn: 1200, requests: 3 } });
  const rows = usageFields(state);
  assert.deepEqual(rows.map((row) => row.label), ['tokens', 'calls']);
  assert.equal(rows[0]?.value, '1.2k in', 'output tokens were never reported, so no "0 out"');
});

test('the context meter is sized to the model that actually answered', () => {
  const state = run(fresh(),
    { type: 'usage/set', usage: { contextTokens: 100_000 } },
    { type: 'route/observed', decision: { at: 1, attempts: 0, fallback: false, model: 'claude-sonnet-4-6' } });
  const meter = contextUse(state, new Map([['claude-sonnet-4-6', 200_000]]));
  assert.ok(meter);
  assert.equal(meter.window, 200_000);
  assert.equal(meter.zone, 'ok');
});

// --- approvals -------------------------------------------------------------

test('an approval takes the phase and gives it back to the run it blocked', () => {
  let state = run(fresh(), { type: 'run/start', prompt: 'x', at: 1 }, { type: 'run/phase', phase: 'tool' });
  state = reduce(state, {
    type: 'approval/request',
    approval: { tool: 'run_command', input: {}, scopes: [], askedAt: 2 },
  });
  assert.equal(state.phase, 'awaiting-approval');
  state = reduce(state, { type: 'stream/answer', delta: 'x' });
  assert.equal(state.phase, 'awaiting-approval', 'nothing quietly relabels the phase mid-gate');
  state = reduce(state, { type: 'approval/resolve' });
  assert.equal(state.phase, 'tool');
});

test('an approval resolved with no run in flight returns to idle, not to a stuck phase', () => {
  let state = reduce(fresh(), {
    type: 'approval/request',
    approval: { tool: 'run_command', input: {}, scopes: [], askedAt: 1 },
  });
  state = reduce(state, { type: 'approval/resolve' });
  assert.equal(state.phase, 'idle');
});

// --- sessions --------------------------------------------------------------

test('restoring a session replaces history and bumps the epoch', () => {
  const before = run(fresh(), { type: 'notice', level: 'info', at: 1, text: 'old' });
  const after = reduce(before, {
    type: 'session/restore', name: 'yesterday',
    entries: [{ kind: 'user', id: 'u1', at: 1, text: 'hello' }],
    plan: [{ id: 's1', title: 'step', status: 'pending' }],
  });
  assert.equal(after.epoch, before.epoch + 1, 'the scrollback region is restarted, not extended');
  assert.deepEqual(after.transcript.map((entry) => entry.kind), ['user']);
  assert.equal(after.session.resumedFrom, 'yesterday');
  assert.equal(after.lens, 'run');
});

test('a reset clears everything a previous task left behind', () => {
  const state = run(fresh(),
    { type: 'run/start', prompt: 'x', at: 1 },
    startTool('c1'),
    { type: 'plan/set', steps: [{ id: '1', title: 'a', status: 'done' }] },
    { type: 'usage/set', usage: { tokensIn: 5 } },
    { type: 'session/reset' });
  assert.deepEqual(state.transcript, []);
  assert.deepEqual(state.plan, []);
  assert.deepEqual(state.usage, {});
  assert.deepEqual(state.route, { history: [] });
  assert.equal(state.phase, 'idle');
});

// --- navigation ------------------------------------------------------------

test('cycling lenses wraps and resets the list cursor', () => {
  let state = run(fresh(), { type: 'lens/move', delta: 3, size: 10 });
  assert.equal(state.lensCursor, 3);
  state = reduce(state, { type: 'lens/cycle', direction: 1 });
  assert.equal(state.lens, 'agents');
  assert.equal(state.lensCursor, 0);
  for (let i = 0; i < 4; i += 1) state = reduce(state, { type: 'lens/cycle', direction: 1 });
  assert.equal(state.lens, 'run', 'five steps from run comes back to run');
});

test('a list cursor cannot leave the list', () => {
  const state = run(fresh(), { type: 'lens/move', delta: -5, size: 3 });
  assert.equal(state.lensCursor, 0);
  assert.equal(reduce(state, { type: 'lens/move', delta: 99, size: 3 }).lensCursor, 2);
});

test('typing in the palette resets the selection so enter cannot run a stale row', () => {
  let state = reduce(fresh(), { type: 'overlay/open', overlay: { kind: 'palette', query: '', index: 0 } });
  state = reduce(state, { type: 'overlay/move', delta: 4, size: 10 });
  assert.equal(state.overlay?.index, 4);
  state = reduce(state, { type: 'overlay/query', query: 'ro' });
  assert.equal(state.overlay?.index, 0);
});

// --- derived labels --------------------------------------------------------

test('the phase label describes the work, not the machine', () => {
  assert.equal(phaseLabel(fresh()), 'ready');
  assert.equal(phaseLabel(run(fresh(), { type: 'stream/reasoning', delta: 'a' })), 'thinking');
  assert.equal(phaseLabel(run(fresh(), startTool('c1', 'run_command'))), 'running a command');
  assert.equal(phaseLabel(run(fresh(), startTool('c1'), startTool('c2'))), '2 tools');
});

test('plan progress names the active step', () => {
  const state = run(fresh(), {
    type: 'plan/set',
    steps: [
      { id: '1', title: 'a', status: 'done' },
      { id: '2', title: 'b', status: 'active' },
      { id: '3', title: 'c', status: 'pending' },
    ],
  });
  const progress = planProgress(state.plan);
  assert.equal(progress.done, 1);
  assert.equal(progress.total, 3);
  assert.equal(progress.active?.title, 'b');
  assert.ok(railHasContent(state));
});

test('tool history reads newest first', () => {
  const state = run(fresh(),
    startTool('c1'), { type: 'tool/end', id: 'c1', outcome: 'ok', at: 2 },
    startTool('c2'), { type: 'tool/end', id: 'c2', outcome: 'ok', at: 3 });
  assert.deepEqual(toolHistory(state).map((tool) => tool.id), ['c2', 'c1']);
});

test('an empty session has nothing for the wide-terminal rail', () => {
  assert.equal(railHasContent(fresh()), false);
});

test('the narrative before a tool call is kept, and the next round does not run onto the end of it', () => {
  let state = run(fresh(),
    { type: 'run/start', prompt: 'go', at: 1 },
    { type: 'stream/answer', delta: 'Reading the manifest.' },
    startTool('c1'));

  assert.equal(state.live.answer, '', 'the buffer is closed off at the tool call');
  const settled = state.transcript.filter((entry) => entry.kind === 'assistant');
  assert.equal(settled.length, 1);
  assert.ok(settled[0]?.kind === 'assistant' && settled[0].text === 'Reading the manifest.');

  state = run(state,
    { type: 'tool/end', id: 'c1', outcome: 'ok', at: 2 },
    { type: 'stream/answer', delta: 'It is called omniharness-cli.' });
  assert.equal(state.live.answer, 'It is called omniharness-cli.', 'the second round starts clean');
});

test('a tool call with no narrative before it settles nothing', () => {
  const state = run(fresh(), { type: 'run/start', prompt: 'go', at: 1 }, startTool('c1'));
  assert.equal(state.transcript.filter((entry) => entry.kind === 'assistant').length, 0);
});
