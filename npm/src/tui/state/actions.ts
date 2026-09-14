/**
 * Every way the UI state can change, as one closed union.
 *
 * Views never mutate state and never call the engine directly: they dispatch
 * one of these. That is what makes the reducer testable without a terminal and
 * what keeps event handling out of the components — the old interface had
 * twenty-five `useState` setters called from four different layers, and no
 * single place to read to find out what could change what.
 */

import type { AgentMode, PermissionMode } from '../../types/index.js';
import type {
  AgentStatus,
  CompressionSummary,
  Entry,
  LensId,
  NoticeLevel,
  Overlay,
  PendingApproval,
  PickerEntry,
  PlanStep,
  RouteDecision,
  SavedSession,
  ToolOutcome,
  UsageState,
} from './types.js';

export type Action =
  // -- terminal -------------------------------------------------------------
  | { type: 'terminal/resize'; columns: number; rows: number }
  | { type: 'terminal/kitty'; supported: boolean }

  // -- composer -------------------------------------------------------------
  | { type: 'composer/set'; value: string; cursor: number }
  | { type: 'composer/clear' }
  | { type: 'composer/queue'; prompt: string }
  | { type: 'composer/dequeue' }

  // -- run lifecycle --------------------------------------------------------
  | { type: 'run/start'; prompt: string; at: number }
  | { type: 'run/phase'; phase: 'thinking' | 'streaming' | 'tool' | 'cancelling' }
  | { type: 'run/end'; at: number }
  | { type: 'run/failed'; message: string; at: number }

  // -- streaming ------------------------------------------------------------
  | { type: 'stream/reasoning'; delta: string }
  | { type: 'stream/answer'; delta: string }
  | { type: 'stream/reasoningDone'; text: string; at: number }
  | {
      type: 'stream/answerDone';
      text: string;
      at: number;
      model?: string;
      provider?: string;
      fallback?: boolean;
      compression?: CompressionSummary;
    }

  // -- tools ----------------------------------------------------------------
  | {
      type: 'tool/start';
      id: string;
      name: string;
      verb: string;
      target: string;
      agentId?: string;
      at: number;
    }
  | {
      type: 'tool/end';
      id: string;
      outcome: Exclude<ToolOutcome, 'running'>;
      summary?: string;
      detail?: string;
      at: number;
      /** Used only when no matching call was seen start, so the row still reads. */
      name?: string;
      verb?: string;
    }
  | { type: 'tool/reveal'; id: string; at: number }

  // -- plan and agents ------------------------------------------------------
  | { type: 'plan/set'; steps: readonly PlanStep[] }
  | { type: 'agent/update'; id: string; label: string; status: AgentStatus; note?: string; at: number }
  | { type: 'agents/settle'; at: number }

  // -- routing and usage ----------------------------------------------------
  | { type: 'route/observed'; decision: RouteDecision }
  | { type: 'route/cooldown'; until: string }
  | { type: 'usage/set'; usage: UsageState }

  // -- approvals ------------------------------------------------------------
  | { type: 'approval/request'; approval: PendingApproval }
  | { type: 'approval/resolve' }

  // -- navigation -----------------------------------------------------------
  | { type: 'lens/set'; lens: LensId }
  | { type: 'lens/cycle'; direction: 1 | -1 }
  | { type: 'lens/move'; delta: number; size: number }
  | { type: 'overlay/open'; overlay: Overlay }
  | { type: 'overlay/close' }
  | { type: 'overlay/query'; query: string }
  | { type: 'overlay/move'; delta: number; size: number }
  | { type: 'overlay/models'; items: readonly PickerEntry[]; selected?: string; error?: string }

  // -- session --------------------------------------------------------------
  | { type: 'session/mode'; mode: AgentMode }
  | { type: 'session/permission'; permission: PermissionMode }
  | { type: 'session/model'; model: string }
  | { type: 'session/saved'; saved: readonly SavedSession[] }
  | { type: 'session/restore'; name: string; entries: readonly Entry[]; plan: readonly PlanStep[] }
  | { type: 'session/reset' }
  | { type: 'session/preview'; url: string }

  // -- transcript -----------------------------------------------------------
  | { type: 'notice'; level: NoticeLevel; text: string; at: number }
  | { type: 'entry/append'; entry: Entry };
