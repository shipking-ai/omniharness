import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explainFailure, explainGateway } from '../src/tui/runtime/failure.js';

/** The message the gateway actually sent, as the product printed it. */
const WALL = "OmniRoute 504: [504]: Request exceeded OmniRoute's local rate-limit execution "
  + 'expiration (legacy resilienceSettings.requestQueue.maxWaitMs=60000ms) for '
  + 'gemini-web/gemini-3.1-flash-lite. Bottleneck applies this deadline only after '
  + 'dispatch; it does not bound queue wait and is not an upstream-generated timeout.';

// --- the three facts worth keeping ------------------------------------------

test('the queue-deadline wall keeps its deadline, its target and its status', () => {
  const out = explainGateway(WALL);
  assert.match(out, /60s/, 'the deadline is a duration, not 60000ms to be divided by eye');
  assert.match(out, /on gemini-web\/gemini-3\.1-flash-lite after/,
    'which model it was for — and not a model called `flash-lite.`, with the sentence\'s own full stop');
  assert.match(out, /^OmniRoute 504: /, 'the status a bug report would quote');
});

test('it says whose deadline it was, which is the part the original buries', () => {
  // The wall's last sentence is the one that reads like noise and is the one
  // that matters: the provider did not time out. A reader who misses it goes
  // looking at the model.
  assert.match(explainGateway(WALL), /not the provider/);
  assert.match(explainGateway(WALL), /resilienceSettings\.requestQueue\.maxWaitMs/,
    'and the knob is still named, so the reader can go change it');
});

test('it is shorter than the wall, and drops only the gateway-internal parts', () => {
  const out = explainGateway(WALL);
  assert.ok(out.length < WALL.length / 1.5, `still a wall at ${out.length} chars: ${out}`);
  for (const internal of ['Bottleneck', 'legacy', 'rate-limit execution expiration', 'bound queue wait']) {
    assert.ok(!out.includes(internal), `"${internal}" is for whoever maintains the gateway`);
  }
});

test('the status is not printed twice', () => {
  assert.ok(!explainGateway(WALL).includes('[504]'), 'ours then theirs, saying the same thing');
  assert.equal(
    explainGateway('OmniRoute 502: [502]: upstream refused the connection'),
    'OmniRoute 502: upstream refused the connection',
    'and the doubling is dropped even when there is nothing else to rewrite',
  );
  assert.equal(
    explainGateway('OmniRoute 502: [400]: upstream refused'),
    'OmniRoute 502: [400]: upstream refused',
    'a *different* status in the body is real information, not a repetition',
  );
});

// --- everything else is left exactly as it is -------------------------------

test('an error that already says something useful is left alone', () => {
  for (const message of [
    'too many tool turns (limit 40)',
    'OmniRoute 401: invalid api key',
    'OmniRoute 404: no model named gpt-9 is configured',
    'OmniRoute 429: rate limited, retry after 30s',
  ]) {
    assert.equal(explainGateway(message), message, message);
    assert.equal(explainFailure(new Error(message), 'http://x'), message, message);
  }
});

test('a 504 that is not the queue deadline is not rewritten as if it were', () => {
  // Rewriting on the status alone would put the limiter's story on an error
  // that has nothing to do with the limiter.
  const other = 'OmniRoute 504: upstream provider did not respond within 120s';
  assert.equal(explainGateway(other), other);
});

// --- the parts read out of the text, not assumed ----------------------------

test('a deadline with no model named still reads as a sentence', () => {
  const out = explainGateway('OmniRoute 504: expired (maxWaitMs=5000ms)');
  assert.match(out, /5s/);
  assert.ok(!/ on /.test(out), `invented a target: ${out}`);
});

test('the deadline is rendered at the scale it was given in', () => {
  assert.match(explainGateway('x maxWaitMs=250ms'), /250ms/);
  assert.match(explainGateway('x maxWaitMs=1500ms'), /1\.5s/);
  assert.match(explainGateway('x maxWaitMs=60000ms'), /60s/);
  assert.match(explainGateway('x maxWaitMs=300000ms'), /5m/);
});

test('a bare wall with no OmniRoute prefix does not grow a fake status', () => {
  const out = explainGateway('Request expired (maxWaitMs=60000ms) for openai/gpt-4o');
  assert.ok(!/\d{3}/.test(out.split('60s')[0] ?? ''), `invented a status: ${out}`);
  assert.match(out, /openai\/gpt-4o/);
});

// --- the connection case still wins -----------------------------------------

test('a connection failure names the gateway and what to do about it', () => {
  for (const message of ['fetch failed', 'connect ECONNREFUSED 127.0.0.1:20128', 'socket hang up']) {
    const explained = explainFailure(new Error(message), 'http://localhost:20128');
    assert.match(explained, /cannot reach OmniRoute at http:\/\/localhost:20128/, message);
    assert.match(explained, /check that it is running/);
  }
});

test('a connection failure hidden in a cause is still recognised', () => {
  const error = new Error('fetch failed');
  (error as { cause?: unknown }).cause = new Error('connect ECONNREFUSED 127.0.0.1:20128');
  assert.match(explainFailure(error, 'http://x'), /cannot reach OmniRoute/);
});

test('a thrown non-error is still explained rather than printed as [object Object]', () => {
  assert.equal(explainFailure('plain string failure', 'http://x'), 'plain string failure');
});
