/**
 * The reducer: the only place UI state changes.
 *
 * Pure, exhaustive over {@link Action}, and free of anything terminal-shaped —
 * it can be exercised at full speed in a test with no renderer. Two invariants
 * it is responsible for:
 *
 *  - The transcript is append-only and holds settled entries only, because it is
 *    rendered into the terminal's own scrollback and can never be redrawn.
 *  - Everything settles the moment it is final, so the transcript is in the
 *    order the work happened: narrative, then the call it led to, then the
 *    answer that followed. Holding finished calls back in the live region — an
 *    earlier attempt at making their output expandable in place — printed them
 *    *after* the answer they preceded, which is worse than not expanding at all.
 *    Output is revealed by printing it below instead; see `tool/reveal`.
 *  - Nothing is invented. A figure that was not reported stays undefined; the
 *    reducer never substitutes a zero to keep a field populated.
 */

import { LENS_ORDER, ROUTE_HISTORY_LIMIT } from './types.js';
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
    revealed: [],
    lensCursor: 0,
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
    case 'run/start':
      return {
        ...state,
        phase: 'preparing',
        runStartedAt: action.at,
        agents: [],
        live: { reasoning: '', answer: '', tools: [] },
        transcript: action.prompt === ''
          ? state.transcript
          : append(state.transcript, { kind: 'user', id: nextId('u'), at: action.at, text: action.prompt }),
        composer: { ...state.composer, value: '', cursor: 0 },
      };
    case 'run/phase':
      // An approval is a hard stop: nothing else may quietly relabel the phase
      // while the user is being asked a question.
      if (state.phase === 'awaiting-approval' || state.phase === 'idle') return state;
      if (state.phase === 'cancelling' && action.phase !== 'cancelling') return state;
      return state.phase === action.phase ? state : { ...state, phase: action.phase };
    case 'run/end': {
      // Anything still open when the run ends did not finish: record it as a
      // failure rather than leaving a marker that will never resolve.
      const closed = state.live.tools.reduce(
        (list, tool) => append(list, settleTool({ ...tool, outcome: 'error', endedAt: action.at })),
        state.transcript,
      );
      return {
        ...state,
        phase: 'idle',
        runStartedAt: undefined,
        transcript: state.phase === 'cancelling'
          ? append(closed, { kind: 'notice', id: nextId('n'), at: action.at, level: 'warn', text: 'cancelled' })
          : closed,
        live: { reasoning: '', answer: '', tools: [] },
        agents: state.agents.map((agent) =>
          agent.status === 'working' || agent.status === 'spawned'
            ? { ...agent, status: 'done' as const, updatedAt: action.at }
            : agent),
      };
    }
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
        phase: holdsPhase(state.phase) ? state.phase : 'thinking',
        live: { ...state.live, reasoning: state.live.reasoning + action.delta },
      };
    case 'stream/answer':
      return {
        ...state,
        phase: holdsPhase(state.phase) ? state.phase : 'streaming',
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
      // A turn the user stopped did not produce a reply. The engine closes one
      // with a placeholder text event; rendering that as the assistant speaking
      // puts words in its mouth. The note that the turn was cancelled is
      // written once, by `run/end`, so it appears whether or not the engine
      // sent a placeholder at all.
      if (state.phase === 'cancelling') {
        return { ...state, live: { ...state.live, answer: '', reasoning: '' } };
      }
      const entry: Entry = {
        kind: 'assistant',
        id: nextId('a'),
        at: action.at,
        text: action.text,
        showRoute: routeIsNews(state, action.provider, action.model, action.fallback),
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
        phase: holdsPhase(state.phase) ? state.phase : 'tool',
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
        id: action.id,
        name: action.name ?? action.id,
        verb: action.verb ?? action.name ?? action.id,
        target: '',
        outcome: 'running',
        startedAt: action.at,
      };
      const settled: ToolRecord = {
        ...base,
        outcome: action.outcome,
        endedAt: action.at,
        ...(action.summary !== undefined ? { summary: action.summary } : {}),
        ...(action.detail !== undefined ? { detail: action.detail } : {}),
      };
      const remaining = state.live.tools.filter((tool) => tool.id !== action.id);
      return {
        ...state,
        transcript: append(state.transcript, settleTool(settled)),
        live: { ...state.live, tools: remaining },
        phase: state.phase === 'tool' && remaining.length === 0 ? 'streaming' : state.phase,
      };
    }
    case 'tool/reveal': {
      if (state.revealed.includes(action.id)) return state;
      const record = findTool(state, action.id);
      if (record === undefined || record.detail === undefined || record.detail === '') return state;
      return {
        ...state,
        revealed: [...state.revealed, action.id],
        transcript: append(state.transcript, {
          kind: 'output', id: nextId('o'), at: action.at, tool: record,
        }),
      };
    }

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
    case 'route/cooldown':
      if (state.route.cooldownUntil === action.until) return state;
      return { ...state, route: { ...state.route, cooldownUntil: action.until } };
    case 'route/observed': {
      const history = [...state.route.history, action.decision].slice(-ROUTE_HISTORY_LIMIT);
      return {
        ...state,
        route: {
          ...state.route,
          current: action.decision,
          history,
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
        // Appended, not swapped in: the conversation that was on screen stays
        // in scrollback above the one being resumed, the way a terminal works.
        transcript: action.entries.reduce((list, entry) => append(list, entry), state.transcript),
        plan: action.plan,
        live: { reasoning: '', answer: '', tools: [] },
        agents: [],
        session: { ...state.session, resumedFrom: action.name },
        lens: 'run',
        overlay: undefined,
      };
    case 'session/reset':
      // The transcript is what has already been printed; it cannot be unprinted.
      // What resets is the work: the plan, the workers, the meters, the model's
      // own history (which the controller clears alongside this).
      return {
        ...state,
        plan: [],
        agents: [],
        live: { reasoning: '', answer: '', tools: [] },
        route: { history: [] },
        usage: {},
        revealed: [],
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

/** The record for a call, whether it is still running or already in scrollback. */
function findTool(state: AppState, id: string): ToolRecord | undefined {
  const live = state.live.tools.find((tool) => tool.id === id);
  if (live !== undefined) return live;
  for (let i = state.transcript.length - 1; i >= 0; i -= 1) {
    const entry = state.transcript[i]!;
    if (entry.kind === 'tool' && entry.tool.id === id) return entry.tool;
  }
  return undefined;
}

/**
 * Whether this reply's route is worth a line of its own. It has to say
 * something the session did not already know: the first reply that names a
 * provider does, a later change of provider or model does, a failover always
 * does. Repeating the same provider under every turn is chrome, and the status
 * line already carries it.
 */
function routeIsNews(
  state: AppState,
  provider: string | undefined,
  model: string | undefined,
  fallback: boolean | undefined,
): boolean {
  if (fallback === true) return true;
  // With no provider named, the "model" is whatever the session asked for —
  // repeating the engine alias under its own reply says nothing.
  if (provider === undefined && (model === undefined || model === state.session.model)) return false;
  for (let i = state.transcript.length - 1; i >= 0; i -= 1) {
    const entry = state.transcript[i]!;
    if (entry.kind !== 'assistant') continue;
    // The narrative a turn writes before reaching for a tool is an assistant
    // entry too, and it names no route. Comparing against it made every reply
    // look like a change of provider, so the line came back on every turn.
    if (entry.provider === undefined && entry.model === undefined) continue;
    return entry.provider !== provider || entry.model !== model;
  }
  return true;
}

/**
 * Phases that nothing may quietly relabel: the user is being asked a question,
 * or has already asked for the turn to stop.
 */
const holdsPhase = (phase: AppState['phase']): boolean =>
  phase === 'awaiting-approval' || phase === 'cancelling';

const settleTool = (tool: ToolRecord): Entry => ({
  kind: 'tool', id: `t-${tool.id}`, at: tool.endedAt ?? tool.startedAt, tool,
});

/**
 * Append. The transcript only ever grows, and that is a hard requirement, not a
 * simplification: Ink's `<Static>` remembers how many items it has already
 * written and prints `items.slice(thatIndex)`. Shrinking the array — capping it,
 * clearing it on `/clear`, replacing it on a resume — leaves that index past the
 * end, and the transcript silently stops printing for the rest of the session.
 *
 * Clearing and resuming therefore append rather than replace, which is also
 * what a terminal does: what came before stays in scrollback above.
 */
function append(list: readonly Entry[], entry: Entry): readonly Entry[] {
  return [...list, entry];
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
