import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialState, reduce, resetIds } from '../src/tui/state/reducer.js';
import {
  agentProgress, contextUse, fallbackHistory, phaseLabel, planProgress,
  railHasContent, routeFields, routeSummary, toolHistory, usageFields,
} from '../src/tui/state/selectors.js';
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

test('the transcript only ever grows, because Ink cannot un-print a row', () => {
  // Shrinking it leaves Ink's static write-index past the end of the array, and
  // the transcript silently stops printing for the rest of the session.
  let state = fresh();
  for (let i = 0; i < 1500; i += 1) {
    state = reduce(state, { type: 'notice', level: 'info', at: i, text: `n${i}` });
  }
  assert.equal(state.transcript.length, 1500);
  assert.ok(state.transcript[0]?.kind === 'notice' && state.transcript[0].text === 'n0');
});

test('clearing and resuming append rather than replace', () => {
  let state = run(fresh(), { type: 'notice', level: 'info', at: 1, text: 'the old conversation' });
  const before = state.transcript.length;

  state = reduce(state, { type: 'session/reset' });
  assert.equal(state.transcript.length, before, 'what was printed stays printed');
  assert.deepEqual(state.plan, [], 'the work resets, though');

  state = reduce(state, {
    type: 'session/restore', name: 'yesterday',
    entries: [{ kind: 'user', id: 'u1', at: 2, text: 'a restored question' }],
    plan: [],
  });
  assert.equal(state.transcript.length, before + 1);
  assert.equal(state.session.resumedFrom, 'yesterday');
});

// --- tools -----------------------------------------------------------------

const startTool = (id: string, name = 'read_file', at = 1): Action =>
  ({ type: 'tool/start', id, name, verb: name === 'run_command' ? '$' : 'read', target: `${id}.go`, at });

test('a call settles the moment it finishes, so the transcript is in the order the work happened', () => {
  let state = run(fresh(), { type: 'run/start', prompt: 'go', at: 0 }, startTool('c1'));
  assert.equal(state.live.tools.length, 1);
  assert.equal(state.transcript.filter((entry) => entry.kind === 'tool').length, 0);

  state = reduce(state, { type: 'tool/end', id: 'c1', outcome: 'ok', summary: '12 lines', at: 5 });
  assert.equal(state.live.tools.length, 0);
  const entry = state.transcript.at(-1);
  assert.ok(entry?.kind === 'tool');
  assert.equal(entry.tool.outcome, 'ok');
  assert.equal(entry.tool.endedAt, 5);
});

test('the answer settles after the call it followed, never before it', () => {
  const state = run(fresh(),
    { type: 'run/start', prompt: 'go', at: 0 },
    { type: 'stream/answer', delta: 'Reading the manifest.' },
    startTool('c1'),
    { type: 'tool/end', id: 'c1', outcome: 'ok', summary: 'read', at: 5 },
    { type: 'stream/answer', delta: 'It is omniharness-cli.' },
    { type: 'stream/answerDone', text: 'It is omniharness-cli.', at: 6 });
  assert.deepEqual(state.transcript.map((entry) => entry.kind), ['user', 'assistant', 'tool', 'assistant']);
});

test('interleaved calls are matched by id, not by arrival order', () => {
  let state = run(fresh(), startTool('c1'), startTool('c2', 'run_command'));
  state = reduce(state, { type: 'tool/end', id: 'c1', outcome: 'error', summary: 'boom', at: 6 });

  assert.deepEqual(state.live.tools.map((tool) => tool.id), ['c2'], 'the other call is untouched');
  assert.equal(state.live.tools[0]?.outcome, 'running');
  const settled = state.transcript.at(-1);
  assert.ok(settled?.kind === 'tool');
  assert.equal(settled.tool.id, 'c1', 'the result belongs to the call that produced it');
  assert.equal(settled.tool.outcome, 'error');
});

test('a result for a call that was never seen start is still recorded', () => {
  const state = run(fresh(), { type: 'tool/end', id: 'ghost', outcome: 'ok', summary: 'done', at: 3 });
  const entry = state.transcript.at(-1);
  assert.ok(entry?.kind === 'tool');
  assert.equal(entry.tool.outcome, 'ok');
});

test('a run that ends with a tool still open marks it failed rather than leaving it spinning', () => {
  const state = run(fresh(),
    { type: 'run/start', prompt: 'x', at: 1 },
    startTool('c1'),
    { type: 'run/end', at: 9 });
  assert.equal(state.live.tools.length, 0);
  const entry = state.transcript.at(-1);
  assert.ok(entry?.kind === 'tool');
  assert.equal(entry.tool.outcome, 'error');
  assert.equal(state.phase, 'idle');
});

test('revealing a call prints its output once, below where the call already is', () => {
  let state = run(fresh(),
    startTool('c1'),
    { type: 'tool/end', id: 'c1', outcome: 'ok', summary: '2 lines', detail: 'a\nb', at: 5 },
    { type: 'tool/reveal', id: 'c1', at: 6 });
  assert.deepEqual(state.transcript.map((entry) => entry.kind), ['tool', 'output']);
  assert.deepEqual(state.revealed, ['c1']);

  state = reduce(state, { type: 'tool/reveal', id: 'c1', at: 7 });
  assert.equal(state.transcript.length, 2, 'asking twice does not print twice');
});

test('a call with no output cannot be revealed', () => {
  const state = run(fresh(),
    startTool('c1'),
    { type: 'tool/end', id: 'c1', outcome: 'ok', summary: 'nothing to show', at: 5 },
    { type: 'tool/reveal', id: 'c1', at: 6 });
  assert.deepEqual(state.transcript.map((entry) => entry.kind), ['tool']);
  assert.deepEqual(state.revealed, []);
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
  assert.deepEqual(rows.map((row) => row.label), ['tokens', 'requests']);
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

test('restoring a session brings back its plan and returns to the run view', () => {
  const after = run(fresh(),
    { type: 'lens/set', lens: 'sessions' },
    {
      type: 'session/restore', name: 'yesterday',
      entries: [{ kind: 'user', id: 'u1', at: 1, text: 'hello' }],
      plan: [{ id: 's1', title: 'step', status: 'pending' }],
    });
  assert.deepEqual(after.transcript.map((entry) => entry.kind), ['user']);
  assert.deepEqual(after.plan.map((step) => step.title), ['step']);
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

test('the route is named under a reply only when it is news', () => {
  const answer = (text: string, at: number, provider: string, fallback = false) =>
    ({ type: 'stream/answerDone' as const, text, at, provider, model: 'm', fallback });

  let state = run(fresh(), answer('one', 1, 'openai'));
  const first = state.transcript.at(-1);
  assert.ok(first?.kind === 'assistant' && first.showRoute === true, 'the first reply names its route');

  state = reduce(state, answer('two', 2, 'openai'));
  const same = state.transcript.at(-1);
  assert.ok(same?.kind === 'assistant' && same.showRoute === false, 'the same route again is not news');

  state = reduce(state, answer('three', 3, 'anthropic'));
  const changed = state.transcript.at(-1);
  assert.ok(changed?.kind === 'assistant' && changed.showRoute === true, 'a different provider is news');

  state = reduce(state, answer('four', 4, 'anthropic', true));
  const failed = state.transcript.at(-1);
  assert.ok(failed?.kind === 'assistant' && failed.showRoute === true, 'a failover is always news');
});

test('a tool call with no narrative before it settles nothing', () => {
  const state = run(fresh(), { type: 'run/start', prompt: 'go', at: 1 }, startTool('c1'));
  assert.equal(state.transcript.filter((entry) => entry.kind === 'assistant').length, 0);
});

test('a cancelled turn is noted once, whether or not the engine sends a placeholder', () => {
  const withPlaceholder = run(fresh(),
    { type: 'run/start', prompt: 'go', at: 1 },
    { type: 'run/phase', phase: 'cancelling' },
    { type: 'stream/answerDone', text: '(cancelled)', at: 2 },
    { type: 'run/end', at: 3 });
  const silent = run(fresh(),
    { type: 'run/start', prompt: 'go', at: 1 },
    { type: 'run/phase', phase: 'cancelling' },
    { type: 'run/end', at: 3 });

  for (const [label, state] of [['with a placeholder', withPlaceholder], ['without one', silent]] as const) {
    const notices = state.transcript.filter((entry) => entry.kind === 'notice');
    assert.equal(notices.length, 1, `${label}: exactly one note`);
    assert.ok(notices[0]?.kind === 'notice' && notices[0].text === 'cancelled', label);
    assert.equal(state.transcript.filter((entry) => entry.kind === 'assistant').length, 0,
      `${label}: the placeholder is not a reply`);
  }
});

test('the narrative before a tool call does not make the next reply look like a route change', () => {
  const turn = (state: AppState, i: number): AppState => run(state,
    { type: 'run/start', prompt: `task ${i}`, at: i },
    { type: 'stream/answer', delta: `Working on ${i}.` },
    startTool(`c${i}`),
    { type: 'tool/end', id: `c${i}`, outcome: 'ok', at: i },
    { type: 'stream/answerDone', text: `Turn ${i}.`, at: i, provider: 'openai', model: 'auto/coding' },
    { type: 'run/end', at: i });

  let state = fresh();
  for (let i = 1; i <= 3; i += 1) state = turn(state, i);
  const announced = state.transcript
    .filter((entry): entry is Extract<typeof entry, { kind: 'assistant' }> => entry.kind === 'assistant')
    .filter((entry) => entry.showRoute === true);
  assert.equal(announced.length, 1, 'only the first reply names the route');
  assert.equal(announced[0]?.text, 'Turn 1.');
});
