/**
 * The reducer: the only place UI state changes.
 *
 * Pure, exhaustive over {@link Action}, and free of anything terminal-shaped —
 * it can be exercised at full speed in a test with no renderer. Two invariants
 * it is responsible for:
 *
 *  - The transcript is append-only and holds settled entries only, because it is
 *    rendered into the terminal's own scrollback and can never be redrawn.
 *  - Tool calls therefore stay in `live.tools` until the *next* run starts, not
 *    until the current one ends. That is what makes their output expandable:
 *    once a row is in scrollback it is frozen, so a call has to remain in the
 *    live region for as long as anyone might want to open it. They are flushed
 *    into the transcript when the next run begins, or earlier if enough of them
 *    pile up, so history survives without the live region growing without end.
 *  - Nothing is invented. A figure that was not reported stays undefined; the
 *    reducer never substitutes a zero to keep a field populated.
 */

import { LENS_ORDER, ROUTE_HISTORY_LIMIT, TRANSCRIPT_LIMIT } from './types.js';
import type {
  AgentRecord,
  AppState,
  Entry,
  LensId,
  ToolRecord,
} from './types.js';
import type { Action } from './actions.js';

let sequence = 0;
/** Monotonic id for entries the UI creates. Never leaves the process. */
export const nextId = (prefix: string): string => {
  sequence += 1;
  return `${prefix}-${sequence.toString(36)}`;
};

/** Reset the id counter. Test-only: keeps ids stable across cases. */
export const resetIds = (): void => { sequence = 0; };

export function initialState(session: AppState['session'], terminal: AppState['terminal']): AppState {
  return {
    session,
    terminal,
    phase: 'idle',
    transcript: [],
    live: { reasoning: '', answer: '', tools: [] },
    plan: [],
    agents: [],
    route: { history: [] },
    usage: {},
    lens: 'run',
    composer: { value: '', cursor: 0 },
    expanded: [],
    lensCursor: 0,
    epoch: 0,
  };
}

export function reduce(state: AppState, action: Action): AppState {
  switch (action.type) {
    // -- terminal -----------------------------------------------------------
    case 'terminal/resize':
      if (state.terminal.columns === action.columns && state.terminal.rows === action.rows) return state;
      return { ...state, terminal: { ...state.terminal, columns: action.columns, rows: action.rows } };
    case 'terminal/kitty':
      return { ...state, terminal: { ...state.terminal, kitty: action.supported } };

    // -- composer -----------------------------------------------------------
    case 'composer/set':
      return { ...state, composer: { ...state.composer, value: action.value, cursor: action.cursor } };
    case 'composer/clear':
      return { ...state, composer: { ...state.composer, value: '', cursor: 0 } };
    case 'composer/queue':
      return { ...state, composer: { value: '', cursor: 0, queued: action.prompt } };
    case 'composer/dequeue':
      return { ...state, composer: { ...state.composer, queued: undefined } };

    // -- run lifecycle ------------------------------------------------------
    case 'run/start': {
      // The previous run's calls go to scrollback now: they have had their
      // chance to be opened, and the new run needs the live region.
      const flushed = state.live.tools.reduce(
        (list, tool) => append(list, settleTool(tool)), state.transcript,
      );
      return {
        ...state,
        phase: 'preparing',
        runStartedAt: action.at,
        agents: [],
        live: { reasoning: '', answer: '', tools: [] },
        transcript: action.prompt === ''
          ? flushed
          : append(flushed, { kind: 'user', id: nextId('u'), at: action.at, text: action.prompt }),
        composer: { ...state.composer, value: '', cursor: 0 },
      };
    }
    case 'run/phase':
      // An approval is a hard stop: nothing else may quietly relabel the phase
      // while the user is being asked a question.
      if (state.phase === 'awaiting-approval' || state.phase === 'idle') return state;
      if (state.phase === 'cancelling' && action.phase !== 'cancelling') return state;
      return state.phase === action.phase ? state : { ...state, phase: action.phase };
    case 'run/end':
      return {
        ...state,
        phase: 'idle',
        runStartedAt: undefined,
        live: {
          reasoning: '',
          answer: '',
          // Anything still open when the run ends did not finish: say so rather
          // than leaving a marker that will never resolve.
          tools: state.live.tools.map((tool) => tool.outcome === 'running'
            ? { ...tool, outcome: 'error' as const, endedAt: action.at }
            : tool),
        },
        agents: state.agents.map((agent) =>
          agent.status === 'working' || agent.status === 'spawned'
            ? { ...agent, status: 'done' as const, updatedAt: action.at }
            : agent),
      };
    case 'run/failed':
      return {
        ...state,
        transcript: append(state.transcript, {
          kind: 'notice', id: nextId('n'), at: action.at, level: 'error', text: action.message,
        }),
      };

    // -- streaming ----------------------------------------------------------
    case 'stream/reasoning':
      return {
        ...state,
        phase: state.phase === 'awaiting-approval' ? state.phase : 'thinking',
        live: { ...state.live, reasoning: state.live.reasoning + action.delta },
      };
    case 'stream/answer':
      return {
        ...state,
        phase: state.phase === 'awaiting-approval' ? state.phase : 'streaming',
        live: { ...state.live, answer: state.live.answer + action.delta },
      };
    case 'stream/reasoningDone':
      if (action.text === '') return { ...state, live: { ...state.live, reasoning: '' } };
      return {
        ...state,
        transcript: append(state.transcript, {
          kind: 'reasoning', id: nextId('r'), at: action.at, text: action.text,
        }),
        live: { ...state.live, reasoning: '' },
      };
    case 'stream/answerDone': {
      const entry: Entry = {
        kind: 'assistant',
        id: nextId('a'),
        at: action.at,
        text: action.text,
        ...(action.model !== undefined ? { model: action.model } : {}),
        ...(action.provider !== undefined ? { provider: action.provider } : {}),
        ...(action.fallback !== undefined ? { fallback: action.fallback } : {}),
        ...(action.compression !== undefined ? { compression: action.compression } : {}),
      };
      return {
        ...state,
        transcript: action.text === '' ? state.transcript : append(state.transcript, entry),
        live: { ...state.live, answer: '' },
      };
    }

    // -- tools --------------------------------------------------------------
    case 'tool/start': {
      const tool: ToolRecord = {
        id: action.id,
        name: action.name,
        verb: action.verb,
        target: action.target,
        outcome: 'running',
        startedAt: action.at,
        ...(action.agentId !== undefined ? { agentId: action.agentId } : {}),
      };
      // A tool call ends the narrative that led up to it. Settling that text now
      // does two things: it keeps the round the model wrote before reaching for a
      // tool ("Reading the manifest.") in the record, where the engine's final
      // `text` event — which carries only the last round — would have dropped it;
      // and it stops the next round streaming onto the end of this one, which
      // rendered as one run-on sentence spanning a tool call.
      const narrative = state.live.answer.trim();
      return {
        ...state,
        phase: state.phase === 'awaiting-approval' ? state.phase : 'tool',
        transcript: narrative === ''
          ? state.transcript
          : append(state.transcript, {
              kind: 'assistant', id: nextId('a'), at: action.at, text: state.live.answer,
            }),
        live: { ...state.live, answer: '', tools: [...state.live.tools, tool] },
      };
    }
    case 'tool/end': {
      const open = state.live.tools.find((tool) => tool.id === action.id);
      // A result for a call the UI never saw start is still worth recording:
      // dropping it would silently lose the only evidence the call happened.
      const base: ToolRecord = open ?? {
        id: action.id, name: action.id, verb: action.id, target: '',
        outcome: 'running', startedAt: action.at,
      };
      const settled: ToolRecord = {
        ...base,
        outcome: action.outcome,
        endedAt: action.at,
        ...(action.summary !== undefined ? { summary: action.summary } : {}),
        ...(action.detail !== undefined ? { detail: action.detail } : {}),
      };
      const tools = open === undefined
        ? [...state.live.tools, settled]
        : state.live.tools.map((tool) => tool.id === action.id ? settled : tool);
      // Old calls spill into scrollback once enough have piled up, so a long
      // autonomous run cannot grow the live region past the viewport.
      const overflow = Math.max(0, tools.length - LIVE_TOOL_LIMIT);
      const spilled = tools.slice(0, overflow).filter((tool) => tool.outcome !== 'running');
      const kept = tools.filter((tool) => !spilled.includes(tool));
      const stillRunning = kept.some((tool) => tool.outcome === 'running');
      return {
        ...state,
        transcript: spilled.reduce((list, tool) => append(list, settleTool(tool)), state.transcript),
        live: { ...state.live, tools: kept },
        phase: state.phase === 'tool' && !stillRunning ? 'streaming' : state.phase,
      };
    }
    case 'tool/toggleExpanded':
      return {
        ...state,
        expanded: state.expanded.includes(action.id)
          ? state.expanded.filter((id) => id !== action.id)
          : [...state.expanded, action.id],
      };

    // -- plan and agents ----------------------------------------------------
    case 'plan/set':
      return { ...state, plan: action.steps };
    case 'agent/update': {
      const previous = state.agents.find((agent) => agent.id === action.id);
      const record: AgentRecord = {
        id: action.id,
        label: action.label,
        status: action.status,
        // A status-only update carries no note; keeping the last one is the
        // difference between "compiling the parser" and a blank row.
        ...(action.note ?? previous?.note ? { note: action.note ?? previous?.note } : {}),
        startedAt: previous?.startedAt ?? action.at,
        updatedAt: action.at,
      };
      const others = state.agents.filter((agent) => agent.id !== action.id);
      return { ...state, agents: [...others, record].sort((a, b) => a.id.localeCompare(b.id)) };
    }
    case 'agents/settle':
      return {
        ...state,
        agents: state.agents.map((agent) =>
          agent.status === 'working' || agent.status === 'spawned'
            ? { ...agent, status: 'done' as const, updatedAt: action.at }
            : agent),
      };

    // -- routing and usage --------------------------------------------------
    case 'route/observed': {
      const history = [...state.route.history, action.decision].slice(-ROUTE_HISTORY_LIMIT);
      return {
        ...state,
        route: {
          current: action.decision,
          history,
          ...(action.cooldownUntil !== undefined ? { cooldownUntil: action.cooldownUntil } : {}),
        },
        // A failover is a fact about the run, not a footnote: it belongs in the
        // transcript where the turn it affected can be read beside it.
        transcript: action.decision.fallback
          ? append(state.transcript, {
              kind: 'route', id: nextId('rt'), at: action.decision.at, decision: action.decision,
            })
          : state.transcript,
      };
    }
    case 'usage/set':
      return { ...state, usage: action.usage };

    // -- approvals ----------------------------------------------------------
    case 'approval/request':
      return { ...state, approval: action.approval, phase: 'awaiting-approval' };
    case 'approval/resolve':
      if (state.approval === undefined) return state;
      return {
        ...state,
        approval: undefined,
        // Back to the run that was blocked — or to idle when nothing is
        // running, so a gate answered outside a run cannot strand the phase.
        phase: state.phase !== 'awaiting-approval' ? state.phase
          : state.runStartedAt === undefined ? 'idle' : 'tool',
      };

    // -- navigation ---------------------------------------------------------
    case 'lens/set':
      return state.lens === action.lens ? state : { ...state, lens: action.lens, lensCursor: 0 };
    case 'lens/cycle': {
      const at = LENS_ORDER.indexOf(state.lens);
      const next = LENS_ORDER[(at + action.direction + LENS_ORDER.length) % LENS_ORDER.length] as LensId;
      return { ...state, lens: next, lensCursor: 0 };
    }
    case 'lens/move':
      return { ...state, lensCursor: clamp(state.lensCursor + action.delta, 0, Math.max(0, action.size - 1)) };
    case 'overlay/open':
      return { ...state, overlay: action.overlay };
    case 'overlay/close':
      return state.overlay === undefined ? state : { ...state, overlay: undefined };
    case 'overlay/query':
      if (state.overlay?.kind !== 'palette') return state;
      return { ...state, overlay: { ...state.overlay, query: action.query, index: 0 } };
    case 'overlay/move': {
      if (state.overlay === undefined) return state;
      const index = clamp(state.overlay.index + action.delta, 0, Math.max(0, action.size - 1));
      return { ...state, overlay: { ...state.overlay, index } };
    }
    case 'overlay/models': {
      if (state.overlay?.kind !== 'models') return state;
      const index = action.selected === undefined
        ? 0
        : Math.max(0, action.items.findIndex((item) => item.id === action.selected));
      return {
        ...state,
        overlay: {
          kind: 'models',
          items: action.items,
          loading: false,
          index,
          ...(action.error !== undefined ? { error: action.error } : {}),
        },
      };
    }

    // -- session ------------------------------------------------------------
    case 'session/mode':
      return { ...state, session: { ...state.session, mode: action.mode } };
    case 'session/permission':
      return { ...state, session: { ...state.session, permission: action.permission } };
    case 'session/model':
      return { ...state, session: { ...state.session, model: action.model } };
    case 'session/saved':
      return { ...state, session: { ...state.session, saved: action.saved } };
    case 'session/restore':
      return {
        ...state,
        // Replacing history, not extending it: the epoch tells the renderer to
        // start a fresh scrollback region rather than re-emit every entry.
        epoch: state.epoch + 1,
        transcript: action.entries,
        plan: action.plan,
        live: { reasoning: '', answer: '', tools: [] },
        agents: [],
        session: { ...state.session, resumedFrom: action.name },
        lens: 'run',
        overlay: undefined,
      };
    case 'session/reset':
      return {
        ...state,
        epoch: state.epoch + 1,
        transcript: [],
        plan: [],
        agents: [],
        live: { reasoning: '', answer: '', tools: [] },
        route: { history: [] },
        usage: {},
        expanded: [],
        phase: 'idle',
        runStartedAt: undefined,
        approval: undefined,
        overlay: undefined,
        composer: { value: '', cursor: 0 },
        session: { ...state.session, resumedFrom: undefined },
      };
    case 'session/preview':
      return {
        ...state,
        preview: action.url,
        transcript: append(state.transcript, {
          kind: 'notice', id: nextId('n'), at: Date.now(), level: 'success', text: `preview live · ${action.url}`,
        }),
      };

    // -- transcript ---------------------------------------------------------
    case 'notice':
      return {
        ...state,
        transcript: append(state.transcript, {
          kind: 'notice', id: nextId('n'), at: action.at, level: action.level, text: action.text,
        }),
      };
    case 'entry/append':
      return { ...state, transcript: append(state.transcript, action.entry) };
  }
}

/** Finished calls kept in the live region, where their output can be opened. */
const LIVE_TOOL_LIMIT = 12;

const settleTool = (tool: ToolRecord): Entry => ({
  kind: 'tool', id: `t-${tool.id}`, at: tool.endedAt ?? tool.startedAt, tool,
});

/**
 * Append, bounded. The transcript is rendered into the terminal's scrollback,
 * so the array is only a record of what was emitted — an unbounded one grows
 * for the life of the process on a long autonomous run.
 */
function append(list: readonly Entry[], entry: Entry): readonly Entry[] {
  const next = [...list, entry];
  return next.length > TRANSCRIPT_LIMIT ? next.slice(next.length - TRANSCRIPT_LIMIT) : next;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
