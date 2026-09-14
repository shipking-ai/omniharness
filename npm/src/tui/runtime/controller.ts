/**
 * The bridge between the harness engine and the UI state.
 *
 * This is the only module that holds a reference to the engine. Views dispatch
 * intents; the controller turns them into engine calls and turns engine events
 * back into actions. Nothing about routing, tools or orchestration is decided
 * here — the harness decides those — but the session-level sequencing that a
 * client is responsible for (start a run, queue the next prompt, fan a planned
 * crazy-mode run out across workers, persist and restore snapshots) lives here
 * rather than inside a component.
 */

import type { ApprovalAction, ApprovalResolution, MastraEngine } from '../../agent/mastraEngine.js';
import type { AgentMode, HarnessMessage, PermissionMode } from '../../types/index.js';
import { appendPromptHistory } from '../../promptHistory.js';
import { deleteSnapshot, listSessions, loadSnapshot, saveSnapshot } from '../../sessionList.js';
import { windowIndex, type WindowIndex } from '../format/context.js';
import { ingest, verbFor } from './ingest.js';
import { nextId } from '../state/reducer.js';
import type { Dispatch, Store } from '../state/store.js';
import type { Entry, PickerEntry, UsageState } from '../state/types.js';

/** Parallel workers a planned crazy-mode run fans out to. */
const SWARM_AGENTS = 3;
/** A plan smaller than this is faster to finish in one pass than to fan out. */
const SWARM_MIN_STEPS = 2;

export interface Controller {
  submit(prompt: string): void;
  cancel(): void;
  setMode(mode: AgentMode): void;
  setPermission(permission: PermissionMode): void;
  selectModel(model: string): Promise<void>;
  loadModels(): Promise<void>;
  clear(): Promise<void>;
  refreshSessions(): Promise<void>;
  save(name: string): Promise<void>;
  attach(paths: readonly string[]): Promise<void>;
  forget(name: string): Promise<void>;
  resume(name: string): Promise<void>;
  answerApproval(approved: boolean, trust?: string): void;
  /** Context windows from the gateway catalog; empty until it has been read. */
  readonly windows: WindowIndex;
  dispose(): void;
}

export function createController(engine: MastraEngine, store: Store): Controller {
  const dispatch: Dispatch = store.dispatch;
  let disposed = false;
  let running = false;
  let pendingApproval: ((decision: ApprovalResolution) => void) | null = null;
  let windows: WindowIndex = new Map();

  const now = (): number => Date.now();

  /**
   * Fold the client's own counters into the state after anything that could
   * have moved them. They are read rather than accumulated here so the UI can
   * never report a total the gateway did not.
   */
  const syncUsage = (): void => {
    const metrics = engine.client.snapshotMetrics();
    const usage: UsageState = {
      ...(metrics.usage?.contextTokens ? { contextTokens: metrics.usage.contextTokens } : {}),
      ...(metrics.usage?.tokensIn ? { tokensIn: metrics.usage.tokensIn } : {}),
      ...(metrics.usage?.tokensOut ? { tokensOut: metrics.usage.tokensOut } : {}),
      ...(metrics.usage?.costUsd ? { costUsd: metrics.usage.costUsd } : {}),
      ...(metrics.usage?.latencyMs ? { latencyMs: metrics.usage.latencyMs } : {}),
      ...(metrics.requestCount ? { requests: metrics.requestCount } : {}),
      ...(metrics.remainingQuota !== undefined ? { remainingQuota: metrics.remainingQuota } : {}),
      ...(metrics.compression.inputTokens > 0 && metrics.compression.ratio < 1
        ? {
            compression: {
              strategy: metrics.compression.strategy,
              savedTokens: metrics.compression.inputTokens - metrics.compression.compressedTokens,
              savedFraction: 1 - metrics.compression.ratio,
            },
          }
        : {}),
    };
    dispatch({ type: 'usage/set', usage });
    const cooldown = metrics.fallback.cooldownUntil;
    if (cooldown !== undefined && store.getState().route.cooldownUntil !== cooldown && store.getState().route.current) {
      dispatch({ type: 'route/observed', decision: store.getState().route.current!, cooldownUntil: cooldown });
    }
  };

  const unsubscribe = engine.subscribe((event) => {
    if (disposed) return;
    // The engine emits synchronously to every listener in turn, so anything
    // thrown here would propagate into its run loop and take the turn with it.
    // A view is never worth failing a run over: record the fault and carry on.
    try {
      for (const action of ingest(event, now())) dispatch(action);
      if (event.type === 'text' || event.type === 'route') syncUsage();
    } catch (reason: unknown) {
      dispatch({
        type: 'notice', level: 'error', at: now(),
        text: `could not display a '${String((event as { type?: unknown }).type)}' event: `
          + (reason instanceof Error ? reason.message : String(reason)),
      });
    }
  });

  engine.setApprovalHandler((action: ApprovalAction) => new Promise<ApprovalResolution>((resolve) => {
    pendingApproval = resolve;
    dispatch({
      type: 'approval/request',
      approval: {
        tool: action.tool,
        input: action.input,
        scopes: action.scopes.map((scope) => ({ id: scope.id, label: scope.label })),
        askedAt: now(),
      },
    });
  }));

  /** Read the catalog once, so the context meter is sized by the gateway. */
  void engine.client.listCatalog()
    .then((catalog) => { if (!disposed) windows = windowIndex(catalog); })
    .catch(() => { /* an unreadable catalog leaves the meter on its built-in table */ });

  const startRun = (prompt: string): void => {
    running = true;
    dispatch({ type: 'run/start', prompt, at: now() });
    if (prompt !== '') void appendPromptHistory(prompt).catch(() => { /* history is best-effort */ });

    void (async () => {
      try {
        await engine.run(prompt);
        // Fan-out is a session decision, not a model decision: once a crazy-mode
        // planning turn has produced a real queue, the remaining steps run in
        // parallel. The harness owns how a worker behaves; the client owns when
        // to ask for several of them.
        if (
          engine.state.mode === 'crazy'
          && typeof engine.runSwarm === 'function'
          && engine.state.taskQueue.filter((step) => step.status === 'pending').length >= SWARM_MIN_STEPS
        ) {
          await engine.runSwarm({ maxAgents: SWARM_AGENTS });
        }
      } catch (reason: unknown) {
        dispatch({
          type: 'run/failed',
          message: reason instanceof Error ? reason.message : String(reason),
          at: now(),
        });
      } finally {
        running = false;
        dispatch({ type: 'run/end', at: now() });
        syncUsage();
        const queued = store.getState().composer.queued;
        if (queued !== undefined && !disposed) {
          dispatch({ type: 'composer/dequeue' });
          startRun(queued);
        }
      }
    })();
  };

  const entriesFromMessages = (messages: readonly HarnessMessage[]): readonly Entry[] =>
    messages.map((message): Entry => {
      const at = Date.parse(message.createdAt);
      const stamp = Number.isFinite(at) ? at : 0;
      switch (message.role) {
        case 'user':
          return { kind: 'user', id: nextId('u'), at: stamp, text: message.content };
        case 'assistant':
          return {
            kind: 'assistant', id: nextId('a'), at: stamp, text: message.content,
            ...(message.model !== undefined ? { model: message.model } : {}),
          };
        case 'thought':
          return { kind: 'reasoning', id: nextId('r'), at: stamp, text: message.content };
        case 'error':
          return { kind: 'notice', id: nextId('n'), at: stamp, level: 'error', text: message.content };
        case 'tool': {
          const name = message.toolName ?? 'tool';
          return {
            kind: 'tool', id: nextId('t'), at: stamp,
            tool: {
              id: nextId('tr'), name, verb: verbFor(name), target: '',
              outcome: 'ok', summary: message.content.split('\n')[0] ?? '',
              detail: message.content, startedAt: stamp, endedAt: stamp,
            },
          };
        }
        default:
          return { kind: 'notice', id: nextId('n'), at: stamp, level: 'info', text: message.content };
      }
    });

  return {
    get windows() { return windows; },

    submit(prompt) {
      if (prompt.trim() === '') return;
      if (running) {
        dispatch({ type: 'composer/queue', prompt });
        return;
      }
      startRun(prompt);
    },

    cancel() {
      if (!running) return;
      dispatch({ type: 'run/phase', phase: 'cancelling' });
      engine.cancel();
    },

    setMode(mode) {
      engine.state.mode = mode;
      dispatch({ type: 'session/mode', mode });
      dispatch({ type: 'notice', level: 'info', at: now(), text: `mode → ${mode}` });
    },

    setPermission(permission) {
      engine.state.permissionMode = permission;
      dispatch({ type: 'session/permission', permission });
      dispatch({
        type: 'notice', level: permission === 'bypass' ? 'warn' : 'info', at: now(),
        text: `permissions → ${PERMISSION_LABEL[permission]}`
          + (engine.state.mode === 'crazy' ? ' (crazy mode still bypasses)' : ''),
      });
    },

    async selectModel(model) {
      await engine.selectModel(model);
      dispatch({ type: 'session/model', model });
      dispatch({ type: 'notice', level: 'info', at: now(), text: `model → ${model} (saved as default)` });
    },

    async loadModels() {
      dispatch({ type: 'overlay/open', overlay: { kind: 'models', index: 0, items: [], loading: true } });
      try {
        const [combos, catalog] = await Promise.all([engine.client.listCombos(), engine.client.listCatalog()]);
        if (disposed) return;
        windows = windowIndex(catalog);
        const items: PickerEntry[] = [];
        for (const combo of combos) {
          if (combo.name.trim() === '' || items.some((item) => item.id === combo.name)) continue;
          items.push({
            id: combo.name, group: 'your combos',
            ...(combo.strategy !== undefined ? { detail: combo.strategy } : {}),
          });
        }
        for (const id of [...new Set(catalog.map((entry) => entry.id).filter((id) => id.startsWith('auto/')))].sort()) {
          if (!items.some((item) => item.id === id)) items.push({ id, group: 'auto engines' });
        }
        dispatch({ type: 'overlay/models', items, selected: engine.state.activeModel });
      } catch (reason: unknown) {
        if (disposed) return;
        dispatch({
          type: 'overlay/models', items: [],
          error: reason instanceof Error ? reason.message : String(reason),
        });
      }
    },

    async clear() {
      dispatch({ type: 'session/reset' });
      await engine.clearHistory().catch(() => { /* best-effort */ });
    },

    async refreshSessions() {
      const saved = await listSessions(engine.state.workspace.root).catch(() => []);
      if (!disposed) dispatch({ type: 'session/saved', saved });
    },

    async attach(paths) {
      // The engine holds the loaded files until the next prompt goes out, so
      // this is a staging step, not a turn of its own.
      try {
        const loaded = await engine.attach(paths);
        for (const file of loaded) {
          dispatch({
            type: 'notice', level: 'info', at: now(),
            text: `attached ${file.name} · ${file.kind} · ${file.size} bytes — sent with your next prompt`,
          });
        }
      } catch (reason: unknown) {
        dispatch({
          type: 'notice', level: 'error', at: now(),
          text: reason instanceof Error ? reason.message : String(reason),
        });
      }
    },

    async save(name) {
      try {
        await saveSnapshot(engine.state.workspace.root, name, {
          messages: [...engine.state.messages],
          taskQueue: [...engine.state.taskQueue],
          savedAt: new Date().toISOString(),
        });
        dispatch({ type: 'notice', level: 'success', at: now(), text: `session saved · ${name}` });
        await this.refreshSessions();
      } catch (reason: unknown) {
        dispatch({
          type: 'notice', level: 'error', at: now(),
          text: `save failed: ${reason instanceof Error ? reason.message : String(reason)}`,
        });
      }
    },

    async forget(name) {
      await deleteSnapshot(engine.state.workspace.root, name);
      dispatch({ type: 'notice', level: 'info', at: now(), text: `session deleted · ${name}` });
      await this.refreshSessions();
    },

    async resume(name) {
      const snapshot = await loadSnapshot(engine.state.workspace.root, name);
      if (snapshot === null) {
        dispatch({ type: 'notice', level: 'error', at: now(), text: `snapshot ${name} is unreadable` });
        return;
      }
      // The engine's own transcript has to move with the view, or the next turn
      // is sent with the history the user just replaced.
      engine.state.messages = snapshot.messages;
      engine.state.taskQueue = snapshot.taskQueue;
      dispatch({
        type: 'session/restore',
        name,
        entries: entriesFromMessages(snapshot.messages),
        plan: snapshot.taskQueue.map((step) => ({ ...step })),
      });
      dispatch({
        type: 'notice', level: 'success', at: now(),
        text: `resumed ${name} · ${snapshot.messages.length} message${snapshot.messages.length === 1 ? '' : 's'}`,
      });
    },

    answerApproval(approved, trust) {
      const resolve = pendingApproval;
      pendingApproval = null;
      dispatch({ type: 'approval/resolve' });
      resolve?.(trust !== undefined ? { approved, trust } : { approved });
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      // A pending approval left unresolved hangs the engine's tool loop for the
      // life of the process, so unmount denies it rather than abandoning it.
      const resolve = pendingApproval;
      pendingApproval = null;
      resolve?.({ approved: false });
      unsubscribe();
      engine.stop();
    },
  };
}

export const PERMISSION_LABEL: Record<PermissionMode, string> = {
  ask: 'manual',
  acceptEdits: 'accept edits',
  bypass: 'bypass',
};
