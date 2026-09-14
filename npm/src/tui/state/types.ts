/**
 * The normalized UI state model.
 *
 * Nothing in here is a view concern and nothing in here is a backend concern.
 * It is the single description of "what the harness is doing right now", built
 * by the reducer from engine events and read by every view. Two rules hold
 * throughout:
 *
 *  1. Absent means absent. Every measured figure is optional, and a field that
 *     was never reported stays `undefined` rather than becoming `0`. A view
 *     may only render a number it can point at a source for.
 *  2. One shape per meaning. Transcript entries, tool outcomes, agent states
 *     and overlays are discriminated unions, so a view that forgets a case
 *     fails to compile instead of rendering nothing.
 */

import type { AgentMode, PermissionMode } from '../../types/index.js';

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

/**
 * What the harness is doing. `idle` is the only state in which a new prompt
 * starts immediately; everything else queues it.
 */
export type Phase =
  | 'idle'
  | 'preparing'
  | 'thinking'
  | 'streaming'
  | 'tool'
  | 'awaiting-approval'
  | 'cancelling';

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export type ToolOutcome = 'running' | 'ok' | 'error' | 'denied';

export interface ToolRecord {
  /** Stable per call. Results are matched by id, never by arrival order. */
  readonly id: string;
  readonly name: string;
  /** Short verb for the row head ("read", "$", "search"). */
  readonly verb: string;
  /** What the call is acting on: a path, a command, a query. '' when unknown. */
  readonly target: string;
  readonly outcome: ToolOutcome;
  /** First line of the result. */
  readonly summary?: string;
  /** Full captured output, already bounded by the engine. */
  readonly detail?: string;
  /** Set when the call belongs to a parallel worker rather than the main run. */
  readonly agentId?: string;
  readonly startedAt: number;
  readonly endedAt?: number;
}

// ---------------------------------------------------------------------------
// Plan and agents
// ---------------------------------------------------------------------------

export type StepStatus = 'pending' | 'active' | 'done';

export interface PlanStep {
  readonly id: string;
  readonly title: string;
  readonly status: StepStatus;
}

export type AgentStatus = 'spawned' | 'working' | 'done' | 'error';

export interface AgentRecord {
  readonly id: string;
  readonly label: string;
  readonly status: AgentStatus;
  /** Latest note from the worker; kept when a status-only update carries none. */
  readonly note?: string;
  readonly startedAt: number;
  readonly updatedAt: number;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * One routing decision as OmniRoute reported it. Every field except `attempts`
 * and `fallback` is optional because the gateway does not always state them —
 * a missing provider is rendered as unknown, never as a guess.
 */
export interface RouteDecision {
  readonly at: number;
  readonly provider?: string;
  readonly model?: string;
  readonly strategy?: string;
  readonly latencyMs?: number;
  /** Failover attempts the gateway made before this decision. */
  readonly attempts: number;
  readonly fallback: boolean;
  /** The gateway's failure note for the attempt it moved off. */
  readonly reason?: string;
}

export interface RouteState {
  readonly current?: RouteDecision;
  /** Newest last. Bounded — see ROUTE_HISTORY_LIMIT. */
  readonly history: readonly RouteDecision[];
  /** Provider cooldown the gateway reported, ISO-8601. */
  readonly cooldownUntil?: string;
}

// ---------------------------------------------------------------------------
// Usage / budget
// ---------------------------------------------------------------------------

export interface CompressionSummary {
  readonly strategy: string;
  readonly savedTokens: number;
  /** 0–1 of the original prompt that was saved. */
  readonly savedFraction: number;
}

/**
 * What the gateway actually measured this session. Every field is optional:
 * the client reports zeros for anything it was never told, and a zero here
 * would read as a measured zero.
 */
export interface UsageState {
  /** Prompt tokens of the most recent completion — the live context size. */
  readonly contextTokens?: number;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly costUsd?: number;
  readonly latencyMs?: number;
  /** Every HTTP request to the gateway this session, catalog reads included. */
  readonly requests?: number;
  readonly remainingQuota?: number;
  readonly compression?: CompressionSummary;
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

/**
 * A settled transcript entry. Entries are appended only once they are final,
 * because they are rendered into the terminal's own scrollback and can never be
 * redrawn — nor un-printed, which is why the list only ever grows. Anything
 * still changing lives in {@link LiveState} instead.
 */
export type Entry =
  | { readonly kind: 'user'; readonly id: string; readonly at: number; readonly text: string }
  | {
      readonly kind: 'assistant';
      readonly id: string;
      readonly at: number;
      readonly text: string;
      readonly model?: string;
      readonly provider?: string;
      readonly fallback?: boolean;
      readonly compression?: CompressionSummary;
      /**
       * Whether the route is worth naming under this reply. True for the first
       * reply of a session and whenever the provider, the model or the failover
       * state changed — a line repeating the same provider under every turn is
       * chrome, and the status line already carries it.
       */
      readonly showRoute?: boolean;
    }
  | { readonly kind: 'reasoning'; readonly id: string; readonly at: number; readonly text: string }
  | { readonly kind: 'tool'; readonly id: string; readonly at: number; readonly tool: ToolRecord }
  // The output of a call, printed on request. A row already in scrollback can
  // never be redrawn, so "expand" appends the output below rather than
  // pretending to reopen the row above — see the note on Ctrl+T in router.ts.
  | { readonly kind: 'output'; readonly id: string; readonly at: number; readonly tool: ToolRecord }
  | { readonly kind: 'route'; readonly id: string; readonly at: number; readonly decision: RouteDecision }
  | {
      readonly kind: 'notice';
      readonly id: string;
      readonly at: number;
      readonly level: NoticeLevel;
      readonly text: string;
    };

export type NoticeLevel = 'info' | 'warn' | 'error' | 'success';

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export interface ApprovalScopeOption {
  readonly id: string;
  readonly label: string;
}

export interface PendingApproval {
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly scopes: readonly ApprovalScopeOption[];
  readonly askedAt: number;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** The focused lens. Lenses replace the live body; the composer never moves. */
export type LensId = 'run' | 'agents' | 'strategy' | 'route' | 'sessions';

export const LENS_ORDER: readonly LensId[] = ['run', 'agents', 'strategy', 'route', 'sessions'];

export interface PickerEntry {
  readonly id: string;
  readonly group: string;
  readonly detail?: string;
}

/**
 * A modal list on top of the lens. Only one is ever open, so overlay state is
 * one field rather than a boolean per overlay — the old interface could open
 * two at once and route keys to whichever it checked first.
 */
export type Overlay =
  | { readonly kind: 'palette'; readonly query: string; readonly index: number }
  | {
      readonly kind: 'models';
      readonly index: number;
      readonly items: readonly PickerEntry[];
      readonly loading: boolean;
      readonly error?: string;
    };

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface SavedSession {
  readonly name: string;
  readonly savedAt: string;
}

export interface SessionState {
  readonly workspace: string;
  readonly endpoint: string;
  readonly model: string;
  readonly mode: AgentMode;
  readonly permission: PermissionMode;
  readonly version: string;
  readonly skills: number;
  readonly plugins: number;
  readonly mcpTools: number;
  readonly saved: readonly SavedSession[];
  /** Name of the snapshot the current transcript was restored from. */
  readonly resumedFrom?: string;
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

export interface ComposerState {
  readonly value: string;
  readonly cursor: number;
  /** A prompt typed mid-run, sent when the run ends. */
  readonly queued?: string;
}

// ---------------------------------------------------------------------------
// Terminal capabilities
// ---------------------------------------------------------------------------

export interface TerminalState {
  readonly columns: number;
  readonly rows: number;
  /** null until the kitty probe resolves either way. */
  readonly kitty: boolean | null;
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export interface LiveState {
  readonly reasoning: string;
  readonly answer: string;
  /** Calls started and not yet settled, oldest first. */
  readonly tools: readonly ToolRecord[];
}

export interface AppState {
  readonly session: SessionState;
  readonly terminal: TerminalState;
  readonly phase: Phase;
  readonly runStartedAt?: number;
  readonly transcript: readonly Entry[];
  readonly live: LiveState;
  readonly plan: readonly PlanStep[];
  readonly agents: readonly AgentRecord[];
  readonly route: RouteState;
  readonly usage: UsageState;
  readonly approval?: PendingApproval;
  readonly lens: LensId;
  readonly overlay?: Overlay;
  readonly composer: ComposerState;
  /** Ids of calls whose output has already been printed. */
  readonly revealed: readonly string[];
  /** Selected row inside the focused lens, when that lens has a list. */
  readonly lensCursor: number;
  readonly preview?: string;
}

export const ROUTE_HISTORY_LIMIT = 24;
