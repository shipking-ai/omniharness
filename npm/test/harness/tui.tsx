/**
 * Test harness for the terminal interface.
 *
 * One place that knows how to stand a fake terminal up, so a test reads as a
 * sequence of user actions and screen assertions rather than as stream
 * plumbing. Three things it provides:
 *
 *  - `FakeStdout` / `FakeStdin`: the handful of members Ink actually touches,
 *    with a settable size so the same test can be run at several widths.
 *  - `mount`: render the real `App` against a stub engine and hand back the
 *    screen, the keyboard, and the engine's own event emitter.
 *  - `stubEngine`: a `MastraEngine` that records what the UI asked it to do.
 *    Nothing here fakes the *view* — every assertion is against real output.
 */

import React from 'react';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { render, type Instance } from 'ink';
import { App } from '../../src/tui/app.js';
import type {
  ApprovalAction, ApprovalResolution, HarnessEvent, MastraEngine,
} from '../../src/agent/mastraEngine.js';
import type { AgentMode, HarnessMessage, OmniRouteMetrics, PermissionMode, TodoItem } from '../../src/types/index.js';

export class FakeStdin extends PassThrough {
  public isTTY = true;
  public setRawMode(): void { /* Ink asks; a pipe does not care */ }
  public ref(): this { return this; }
  public unref(): this { return this; }
}

export class FakeStdout extends Writable {
  public columns: number;
  public rows: number;
  public output = '';
  /** One Ink frame is one write, so this counts redraws. */
  public writes = 0;

  public constructor(columns = 100, rows = 40) {
    super();
    this.columns = columns;
    this.rows = rows;
  }

  /**
   * The most recent write that carried text.
   *
   * `output` is the whole session, scrollback included, which is what most
   * assertions want. But an assertion about what the interface is showing
   * *now* — the status line's current reading, whether a row is still on
   * screen — cannot use it: a row that scrolled away ten turns ago still
   * matches. Ink redraws its live region in one write, so the last one that
   * was not purely escape sequences is the current frame.
   */
  public lastFrame = '';

  public override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.writes += 1;
    const text = chunk.toString();
    this.output += text;
    if (/[^\x1b\x07\x9b\p{C}]/u.test(text.replace(/\x1b\[[\d;?>$]*[ -/]*[@-~]/g, ''))) this.lastFrame = text;
    callback();
  }

  /** Forget everything written so far, so an assertion is about one moment. */
  public clear(): void { this.output = ''; this.lastFrame = ''; }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Strip ANSI so assertions are about text, not about escape sequences. The CSI
 * pattern covers the whole grammar (parameter bytes, intermediate bytes, final
 * byte), not just the digits-and-letter shape: the interface itself emits
 * `ESC[>1u` and `ESC[?2026$p`, and a narrower pattern left those on screen and
 * made width assertions fail against sequences nobody can see.
 */
export const strip = (text: string): string =>
  text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, '')
    .replace(/\x1b[()][0-9A-Z]/g, '');

export interface StubOptions {
  readonly mode?: AgentMode;
  readonly permissionMode?: PermissionMode;
  readonly model?: string;
  readonly workspace?: string;
  readonly endpoint?: string;
  readonly metrics?: Partial<OmniRouteMetrics>;
  readonly taskQueue?: readonly TodoItem[];
  readonly messages?: readonly HarnessMessage[];
  readonly combos?: readonly { name: string; strategy?: string; models: readonly unknown[] }[];
  readonly catalog?: readonly { id: string; contextLength?: number }[];
  readonly catalogError?: Error;
  /** Resolves the promise `run()` returns; defaults to resolving at once. */
  readonly run?: (prompt: string) => Promise<{ content: string; model: string }>;
  readonly runSwarm?: () => Promise<void>;
}

export interface Stub {
  readonly engine: MastraEngine;
  /** Push an event as the engine would. */
  emit(event: HarnessEvent): void;
  /** Ask for an approval the way the engine's tool loop does. */
  requestApproval(action: ApprovalAction): Promise<ApprovalResolution>;
  readonly calls: {
    runs: string[];
    swarms: number;
    cancels: number;
    models: string[];
    attached: string[];
    cleared: number;
    stopped: number;
  };
}

const baseMetrics = (): OmniRouteMetrics => ({
  compression: { inputTokens: 0, compressedTokens: 0, ratio: 1, strategy: 'none', updatedAt: '' },
  fallback: { attempts: 0 },
  requestCount: 0,
});

export function stubEngine(options: StubOptions = {}): Stub {
  const listeners = new Set<(event: HarnessEvent) => void>();
  let approvalHandler: ((action: ApprovalAction) => Promise<ApprovalResolution>) | undefined;
  const metrics: OmniRouteMetrics = { ...baseMetrics(), ...options.metrics };
  const calls = {
    runs: [] as string[], swarms: 0, cancels: 0,
    models: [] as string[], attached: [] as string[], cleared: 0, stopped: 0,
  };

  const state = {
    taskStatus: 'idle' as const,
    prompt: '',
    mode: options.mode ?? 'build',
    permissionMode: options.permissionMode ?? 'ask',
    activeModel: options.model ?? 'auto/coding',
    workspace: { root: options.workspace ?? '/tmp/workspace', indexedAt: null, files: [], contextLocked: false },
    metrics,
    messages: [...(options.messages ?? [])],
    preview: null,
    taskQueue: [...(options.taskQueue ?? [])],
  };

  const engine = {
    client: {
      endpoint: options.endpoint ?? 'http://localhost:20128',
      snapshotMetrics: () => metrics,
      listCombos: async () => options.combos ?? [],
      listCatalog: async () => {
        if (options.catalogError) throw options.catalogError;
        return options.catalog ?? [];
      },
    },
    tools: {},
    skills: [],
    mcpTools: [],
    state,
    subscribe(listener: (event: HarnessEvent) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    selectModel: async (model: string) => { calls.models.push(model); state.activeModel = model; },
    // Mirrors the engine's own contract: real files are described, a missing
    // one fails the whole call rather than being silently dropped.
    attach: async (paths: readonly string[]) => {
      const loaded: { name: string; kind: string; size: number }[] = [];
      for (const name of paths) {
        const info = await stat(resolve(state.workspace.root, name));
        loaded.push({ name, kind: 'text', size: info.size });
      }
      calls.attached.push(...paths);
      return loaded;
    },
    setApprovalHandler(handler: (action: ApprovalAction) => Promise<ApprovalResolution>) {
      approvalHandler = handler;
    },
    run: async (prompt: string) => {
      calls.runs.push(prompt);
      return options.run ? options.run(prompt) : { content: '', model: state.activeModel };
    },
    runSwarm: async () => {
      calls.swarms += 1;
      if (options.runSwarm) await options.runSwarm();
    },
    cancel: () => { calls.cancels += 1; },
    clearHistory: async () => { calls.cleared += 1; state.messages = []; },
    stop: () => { calls.stopped += 1; },
  } as unknown as MastraEngine;

  return {
    engine,
    emit(event) { for (const listener of [...listeners]) listener(event); },
    requestApproval(action) {
      if (approvalHandler === undefined) throw new Error('the UI installed no approval handler');
      return approvalHandler(action);
    },
    calls,
  };
}

export interface Mounted extends Stub {
  readonly stdin: FakeStdin;
  readonly stdout: FakeStdout;
  readonly instance: Instance;
  /** Everything on screen, ANSI stripped. */
  screen(): string;
  /** Only what the interface is drawing right now, ANSI stripped. */
  live(): string;
  /** Type raw bytes, then let React settle. */
  type(input: string): Promise<void>;
  /** Type a prompt and press enter. The CR is a separate chunk, as a keyboard
   *  sends it — one chunk carrying text and a CR is a paste, not a submit. */
  submit(text: string): Promise<void>;
  /** Let effects and renders settle. */
  settle(ms?: number): Promise<void>;
  unmount(): void;
}

export interface MountOptions extends StubOptions {
  readonly columns?: number;
  readonly rows?: number;
  /** Answer the kitty probe, so the interface knows Shift+Enter is available. */
  readonly kitty?: boolean;
  /**
   * Render into this stream instead of a fresh one. Needed to reproduce what
   * `cli.tsx` does: the resize wrapper has to be the object Ink itself
   * subscribes to, or Ink's own internal listener still redraws per raw event.
   */
  readonly into?: FakeStdout;
}

export async function mount(options: MountOptions = {}): Promise<Mounted> {
  const stub = stubEngine(options);
  const stdin = new FakeStdin();
  const stdout = options.into ?? new FakeStdout(options.columns ?? 100, options.rows ?? 40);
  const instance = render(
    React.createElement(App, { engine: stub.engine }),
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: (options.into ?? stdout) as unknown as NodeJS.WriteStream,
      stderr: new FakeStdout() as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
    },
  );
  await sleep(30);
  if (options.kitty === true) {
    stdin.write('\x1b[?1u');
    await sleep(20);
  }

  return {
    ...stub,
    stdin,
    stdout,
    instance,
    screen: () => strip(stdout.output),
    live: () => strip(stdout.lastFrame),
    async type(input: string) {
      stdin.write(input);
      await sleep(40);
    },
    async submit(text: string) {
      if (text !== '') {
        stdin.write(text);
        await sleep(30);
      }
      stdin.write('\r');
      await sleep(50);
    },
    async settle(ms = 40) { await sleep(ms); },
    unmount() { instance.unmount(); },
  };
}
