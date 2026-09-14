import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mount } from './harness/tui.js';
import type { OmniRouteMetrics } from '../src/types/index.js';

/** Open the route lens: three steps round the cycle from run. */
const toRouteLens = async (app: Awaited<ReturnType<typeof mount>>): Promise<void> => {
  for (let i = 0; i < 3; i += 1) await app.type('\x0c'); // Ctrl+L
  await app.settle(40);
};

const metricsWith = (over: Partial<OmniRouteMetrics>): Partial<OmniRouteMetrics> => ({
  compression: { inputTokens: 0, compressedTokens: 0, ratio: 1, strategy: 'none', updatedAt: '' },
  fallback: { attempts: 0 },
  requestCount: 0,
  ...over,
});

test('the status line shows the provider only once the gateway has named one', async () => {
  const app = await mount({ columns: 100, run: () => new Promise<never>(() => { /* running */ }) });
  assert.ok(!app.screen().includes('via '), 'nothing claims a provider before the gateway reports one');

  await app.submit('go');
  app.emit({ type: 'route', fallback: false, attempts: 0, provider: 'anthropic' });
  await app.settle();
  assert.match(app.screen(), /via anthropic/);
  app.unmount();
});

test('a failover is called a failover, in the transcript and in the status line', async () => {
  const app = await mount({ columns: 100, run: () => new Promise<never>(() => { /* running */ }) });
  await app.submit('go');
  app.emit({
    type: 'route', fallback: true, attempts: 1, provider: 'anthropic',
    reason: 'openai returned 429',
  });
  await app.settle();
  const screen = app.screen();
  assert.match(screen, /failed over to anthropic/);
  assert.match(screen, /openai returned 429/);
  assert.match(screen, /via anthropic \(failover\)/);
  app.unmount();
});

test('the route lens shows every field the gateway reported', async () => {
  const app = await mount({ columns: 100, rows: 40, run: () => new Promise<never>(() => { /* running */ }) });
  await app.submit('go');
  app.emit({
    type: 'route', fallback: true, attempts: 2, provider: 'anthropic',
    model: 'claude-sonnet-4-6', strategy: 'coding:reliable', latencyMs: 812, reason: 'openai 429',
  });
  await toRouteLens(app);
  const screen = app.screen();
  assert.match(screen, /provider\s+anthropic/);
  assert.match(screen, /model\s+claude-sonnet-4-6/);
  assert.match(screen, /profile\s+coding:reliable/);
  assert.match(screen, /latency\s+812ms/);
  assert.match(screen, /attempts\s+3/, 'two failovers means this was the third attempt');
  assert.match(screen, /reason\s+openai 429/);
  app.unmount();
});

test('the route lens invents nothing when the gateway reported nothing', async () => {
  const app = await mount({ columns: 100, rows: 40 });
  await toRouteLens(app);
  const screen = app.screen();
  assert.match(screen, /the gateway has not reported a decision yet/);
  for (const invented of ['provider', 'latency', 'cost', '$0', '0ms', 'failovers']) {
    assert.ok(!screen.includes(invented), `nothing claims "${invented}"`);
  }
  assert.match(screen, /engine\s+auto\/coding/, 'what the session asked for is still stated');
  app.unmount();
});

test('a provider reported without a model does not gain one', async () => {
  const app = await mount({ columns: 100, rows: 40, run: () => new Promise<never>(() => { /* running */ }) });
  await app.submit('go');
  app.emit({ type: 'route', fallback: false, attempts: 0, provider: 'openai' });
  await toRouteLens(app);
  const screen = app.screen();
  assert.match(screen, /provider\s+openai/);
  assert.ok(!/\bmodel\s+\S/.test(screen), 'no model row when the gateway named no model');
  assert.ok(!/\blatency\s+\S/.test(screen), 'no latency row when nothing was timed');
  app.unmount();
});

test('measured usage appears; unmeasured usage stays absent', async () => {
  const app = await mount({
    columns: 100, rows: 40,
    metrics: metricsWith({
      usage: { contextTokens: 0, tokensIn: 4200, tokensOut: 0, costUsd: 0, updatedAt: 'now' },
      requestCount: 2,
    }),
    run: () => new Promise<never>(() => { /* running */ }),
  });
  await app.submit('go');
  app.emit({ type: 'route', fallback: false, attempts: 0, provider: 'openai' });
  await toRouteLens(app);
  const screen = app.screen();
  const tokensRow = screen.split('\n').find((line) => line.includes('tokens')) ?? '';
  assert.match(tokensRow, /tokens\s+4\.2k in/);
  assert.ok(!tokensRow.includes('out'), 'output tokens were never reported, so no "0 out"');
  assert.ok(!screen.split('\n').some((line) => /^\s*cost\b/.test(line)), 'nothing was priced, so no cost row');
  assert.match(screen, /calls\s+2/);
  app.unmount();
});

test('a measured cost is shown to a precision that does not round a turn to free', async () => {
  const app = await mount({
    columns: 100, rows: 40,
    metrics: metricsWith({
      usage: { contextTokens: 0, tokensIn: 10, tokensOut: 5, costUsd: 0.0031, updatedAt: 'now' },
    }),
    run: () => new Promise<never>(() => { /* running */ }),
  });
  await app.submit('go');
  app.emit({ type: 'route', fallback: false, attempts: 0, provider: 'openai' });
  await toRouteLens(app);
  assert.match(app.screen(), /cost\s+\$0\.0031/);
  app.unmount();
});

test('the context meter appears only once a completion has reported prompt tokens', async () => {
  const bare = await mount({ columns: 100, rows: 40 });
  await toRouteLens(bare);
  assert.ok(!bare.screen().includes('window'), 'no meter before anything was measured');
  bare.unmount();

  const measured = await mount({
    columns: 100, rows: 40,
    catalog: [{ id: 'claude-sonnet-4-6', contextLength: 200_000 }],
    metrics: metricsWith({
      usage: { contextTokens: 150_000, tokensIn: 150_000, tokensOut: 0, costUsd: 0, updatedAt: 'now' },
    }),
    run: () => new Promise<never>(() => { /* running */ }),
  });
  await measured.submit('go');
  measured.emit({ type: 'route', fallback: false, attempts: 0, model: 'claude-sonnet-4-6' });
  await toRouteLens(measured);
  const screen = measured.screen();
  assert.match(screen, /window/);
  assert.match(screen, /75%/, 'sized to the model the gateway said answered');
  measured.unmount();
});

test('compression is reported as what it saved, not as a ratio nobody reads', async () => {
  const app = await mount({
    columns: 100, rows: 40,
    metrics: metricsWith({
      compression: { inputTokens: 1000, compressedTokens: 600, ratio: 0.6, strategy: 'rtk', updatedAt: 'now' },
    }),
    run: () => new Promise<never>(() => { /* running */ }),
  });
  await app.submit('go');
  app.emit({ type: 'route', fallback: false, attempts: 0, provider: 'openai' });
  await toRouteLens(app);
  assert.match(app.screen(), /compressed\s+40% saved \(400 tokens\) · RTK/);
  app.unmount();
});

test('every failover in the session is listed, newest first', async () => {
  const app = await mount({ columns: 100, rows: 40, run: () => new Promise<never>(() => { /* running */ }) });
  await app.submit('go');
  app.emit({ type: 'route', fallback: true, attempts: 1, provider: 'anthropic', reason: 'openai 429' });
  app.emit({ type: 'route', fallback: true, attempts: 2, provider: 'google', reason: 'anthropic 529' });
  await toRouteLens(app);
  const screen = app.screen();
  const failovers = screen.slice(screen.indexOf('failovers'));
  assert.ok(failovers.indexOf('google') < failovers.indexOf('anthropic 529') + 40, 'the newest attempt is listed');
  assert.ok(failovers.indexOf('google') < failovers.indexOf('openai 429'), 'newest first');
  app.unmount();
});

test('a catalog the gateway cannot serve does not stop the interface starting', async () => {
  const app = await mount({ columns: 100, catalogError: new Error('connection refused') });
  await app.settle(80);
  assert.match(app.screen(), /OMNIHARNESS/);
  assert.ok(!app.screen().includes('connection refused'), 'a failed background read is not an error banner');
  app.unmount();
});
