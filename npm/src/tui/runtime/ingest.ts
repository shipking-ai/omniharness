/**
 * Engine events → state actions.
 *
 * The only place the UI knows what a `HarnessEvent` looks like. Everything
 * downstream of here speaks the normalized model instead, which is what lets a
 * view be tested by dispatching actions and lets the event contract change
 * without touching a component.
 *
 * Pure: one event in, zero or more actions out, no clock of its own (`at` is
 * passed in so tests are deterministic).
 */

import type { HarnessEvent } from '../../agent/mastraEngine.js';
import type { Action } from '../state/actions.js';
import type { AgentStatus, CompressionSummary, RouteDecision } from '../state/types.js';

/**
 * Short verb for a tool row. Unknown tools keep their own name — inventing a
 * friendly label for a tool this build has never heard of would misdescribe it.
 */
export function verbFor(tool: string): string {
  switch (tool) {
    case 'read_file': return 'read';
    case 'write_file': return 'edit';
    case 'run_command': return '$';
    case 'git_diff': return 'diff';
    case 'semantic_search': return 'search';
    case 'index_workspace': return 'index';
    case 'update_todo': return 'plan';
    case 'write_memory': return 'memory';
    case 'start_preview': return 'preview';
    default: return tool;
  }
}

/**
 * What the call is acting on, taken from the arguments the engine reports.
 * Nothing is fabricated: a tool whose arguments name no subject gets an empty
 * target and renders as the verb alone.
 */
export function targetFor(input: unknown): string {
  if (input === null || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  for (const key of ['path', 'command', 'query', 'url', 'name', 'title'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

const compressionOf = (info: {
  ratio: number; strategy: string; savedTokens: number;
} | undefined): CompressionSummary | undefined => {
  if (info === undefined || !Number.isFinite(info.ratio) || info.ratio >= 1) return undefined;
  return { strategy: info.strategy, savedTokens: info.savedTokens, savedFraction: 1 - info.ratio };
};

/**
 * Translate one engine event.
 *
 * Events the UI has no use for produce no actions rather than a placeholder
 * entry — an unrecognised event must never render as a blank row, and a
 * malformed one must never throw into the engine's emit loop.
 */
export function ingest(event: HarnessEvent, at: number): readonly Action[] {
  switch (event.type) {
    case 'thinking_delta':
      return [{ type: 'stream/reasoning', delta: event.delta }];

    case 'thinking':
      return [{ type: 'stream/reasoningDone', text: event.text, at }];

    case 'text_delta':
      // A worker's narrative belongs to its lane, not to the main answer:
      // merging several workers into one stream produces interleaved nonsense.
      return event.agentId !== undefined ? [] : [{ type: 'stream/answer', delta: event.delta }];

    case 'text': {
      if (event.agentId !== undefined) {
        return [{
          type: 'agent/update',
          id: event.agentId,
          label: event.agentId,
          status: 'working',
          note: firstLine(event.content),
          at,
        }];
      }
      return [{
        type: 'stream/answerDone',
        text: event.content,
        at,
        ...(event.model !== undefined ? { model: event.model } : {}),
        ...(event.provider !== undefined ? { provider: event.provider } : {}),
        ...(event.fallback !== undefined ? { fallback: event.fallback } : {}),
        ...(compressionOf(event.compression) !== undefined
          ? { compression: compressionOf(event.compression) as CompressionSummary }
          : {}),
      }];
    }

    case 'tool_start':
      return [{
        type: 'tool/start',
        // Older engines emitted no id. Falling back to the tool name keeps the
        // pairing working for the common case of one call at a time.
        id: event.id ?? `${event.tool}`,
        name: event.tool,
        verb: verbFor(event.tool),
        target: targetFor(event.input),
        at,
        ...(event.agentId !== undefined ? { agentId: event.agentId } : {}),
      }];

    case 'tool_result':
      return [{
        type: 'tool/end',
        id: event.id ?? `${event.tool}`,
        outcome: event.status ?? 'ok',
        at,
        ...(event.summary !== '' ? { summary: event.summary } : {}),
        ...(event.detail !== undefined ? { detail: event.detail } : {}),
      }];

    case 'approval_requested':
      // The scopes arrive with the approval handler's call, not with this
      // event; the request is recorded there. Emitting nothing here keeps a
      // single place responsible for the pending approval.
      return [];

    case 'route': {
      const decision: RouteDecision = {
        at,
        attempts: event.attempts,
        fallback: event.fallback,
        ...(event.provider !== undefined ? { provider: event.provider } : {}),
        ...(event.model !== undefined ? { model: event.model } : {}),
        ...(event.strategy !== undefined ? { strategy: event.strategy } : {}),
        ...(event.latencyMs !== undefined ? { latencyMs: event.latencyMs } : {}),
        ...(event.reason !== undefined ? { reason: event.reason } : {}),
      };
      return [{ type: 'route/observed', decision }];
    }

    case 'agent':
      return [{
        type: 'agent/update',
        id: event.id,
        label: event.label,
        status: event.status as AgentStatus,
        at,
        ...(event.note !== undefined ? { note: event.note } : {}),
      }];

    case 'todos':
      return [{ type: 'plan/set', steps: event.todos.map((todo) => ({ ...todo })) }];

    case 'preview':
      return [{ type: 'session/preview', url: event.url }];

    case 'attach':
      return [{
        type: 'notice',
        level: 'info',
        at,
        text: `attached ${event.name} · ${event.kind} · ${event.size} bytes`,
      }];

    default:
      // Exhaustiveness is a compile-time guarantee about the union, not a
      // runtime one about the wire: a newer engine, or a malformed event, can
      // still arrive here. Falling off the end returned `undefined`, and the
      // controller's `for…of` then threw back into the engine's emit loop,
      // taking out every listener after this one mid-run.
      checkExhaustive(event);
      return [];
  }
}

/** Fails the build if a case is added to the event union and not handled here. */
function checkExhaustive(_event: never): void { /* the value is the assertion */ }

const firstLine = (text: string): string => (text.split('\n').find((line) => line.trim() !== '') ?? '').slice(0, 100);
