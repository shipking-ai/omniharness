import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import React from 'react';
import { render } from 'ink';
import { App } from '../src/tui/app.js';
import { createMastraEngine } from '../src/agent/mastraEngine.js';
import { FakeStdin, FakeStdout, sleep, strip } from './harness/tui.js';

const sse = (chunks: unknown[]): string =>
  chunks.map((c) => `data: ${JSON.stringify(c)}`).join('\n') + '\ndata: [DONE]\n';

/**
 * Stub OmniRoute gateway:
 *   - planning call (no tool results yet, not a worker frame) → 3 `update_todo` add calls
 *   - planning follow-up (tool results present)              → plain "planned" stop
 *   - worker calls (system frame names "worker agent")       → plain "ok" stop
 */
function stubGateway() {
  const seenWorkerFrames = new Set<string>();
  let inFlightWorkers = 0;
  let peakConcurrentWorkers = 0;
  const server = http.createServer(async (req, res) => {
    // The TUI reads the catalog at start-up to size the context meter; this
    // gateway has no catalog to offer, and that is not what the test is about.
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [] }));
      return;
    }
    const raw: Buffer[] = [];
    for await (const c of req) raw.push(Buffer.from(c));
    const body = JSON.parse(Buffer.concat(raw).toString()) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const text = JSON.stringify(body.messages);
    res.writeHead(200, { 'content-type': 'text/event-stream' });

    const worker = /worker agent (A\d+)/.exec(text);
    if (worker) {
      seenWorkerFrames.add(worker[1]!);
      inFlightWorkers += 1;
      peakConcurrentWorkers = Math.max(peakConcurrentWorkers, inFlightWorkers);
      await sleep(80); // hold the response so parallel workers overlap on the wire
      inFlightWorkers -= 1;
      res.end(sse([
        { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ]));
      return;
    }
    if (body.messages.some((m) => m.role === 'tool')) {
      res.end(sse([
        { choices: [{ index: 0, delta: { content: 'planned 3 tasks' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ]));
      return;
    }
    const call = (i: number, title: string) => ({
      index: i, id: `c${i}`, type: 'function',
      function: { name: 'update_todo', arguments: JSON.stringify({ action: 'add', title }) },
    });
    res.end(sse([
      { choices: [{ index: 0, delta: { tool_calls: [call(0, 'wire the retry backoff')] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [call(1, 'cover the 429 path')] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [call(2, 'update the changelog')] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ]));
  });
  return new Promise<{ url: string; close: () => void; workerFrames: () => number; peakConcurrency: () => number }>((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('no bind');
      resolve({
        url: `http://localhost:${addr.port}`,
        close: () => server.close(),
        workerFrames: () => seenWorkerFrames.size,
        peakConcurrency: () => peakConcurrentWorkers,
      });
    });
  });
}

test('CRAZY mode: a planned run fans out and every worker lane is visible', async () => {
  const gw = await stubGateway();
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'oh-swarm-int-'));
  const engine = await createMastraEngine({ workspaceRoot: workspace, endpoint: gw.url, mode: 'crazy' });
  const stdin = new FakeStdin();
  const stdout = new FakeStdout(100, 44);
  const instance = render(React.createElement(App, { engine }), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: new FakeStdout() as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
  });
  try {
    await sleep(120);
    stdin.write('build the retry work');
    await sleep(60);
    stdin.write('\r'); // submit → engine.run() plans, then the controller fans out

    // Open the agents lens so every lane is listed rather than the top three.
    await sleep(60);
    stdin.write('\x0c'); // Ctrl+L → agents

    // Poll until the swarm finishes.
    let text = '';
    for (let i = 0; i < 80; i += 1) {
      text = strip(stdout.output);
      if (/3 done/.test(text)) break;
      await sleep(50);
    }

    assert.match(text, /agents/, 'the agents lens rendered');
    assert.match(text, /3 done/, 'all three worker lanes completed');
    for (const id of ['A1', 'A2', 'A3']) {
      assert.match(text, new RegExp(`\\b${id}\\b`), `lane ${id} is listed`);
    }

    // The engine really fanned out: three distinct worker system frames were
    // served, and every planned todo was completed by a worker.
    assert.equal(gw.workerFrames(), 3, 'three distinct worker agents hit the gateway');
    assert.ok(gw.peakConcurrency() >= 2, `workers ran concurrently (peak in-flight ${gw.peakConcurrency()})`);
    assert.equal(engine.state.taskQueue.length, 3);
    assert.ok(engine.state.taskQueue.every((t) => t.status === 'done'), 'every todo completed');
  } finally {
    instance.unmount();
    gw.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
