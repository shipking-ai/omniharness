/**
 * Derived views of the state.
 *
 * Anything a component would otherwise compute inline lives here, so the
 * decisions are testable on their own and the same answer reaches every view.
 * These are pure functions of {@link AppState}; none of them reach for the
 * clock, the environment or the engine.
 */

import { contextMeter, type ContextMeter, type WindowIndex } from '../format/context.js';
import { cost, elapsed, millis, tokens } from '../format/units.js';
import type { AppState, PlanStep, RouteDecision, ToolRecord } from './types.js';

/** A short, honest description of what is happening right now. */
export function phaseLabel(state: AppState): string {
  switch (state.phase) {
    case 'idle': return state.composer.queued !== undefined ? 'queued' : 'ready';
    case 'preparing': return 'starting';
    case 'thinking': return 'thinking';
    case 'streaming': return 'responding';
    case 'tool': return describeTools(state.live.tools.filter((tool) => tool.outcome === 'running'));
    case 'awaiting-approval': return 'waiting for you';
    case 'cancelling': return 'cancelling';
  }
}

function describeTools(running: readonly ToolRecord[]): string {
  if (running.length === 0) return 'working';
  if (running.length === 1) return running[0]!.verb === '$' ? 'running a command' : `${running[0]!.verb}…`;
  return `${running.length} tools`;
}

/** Wall time of the current run, or undefined when nothing is running. */
export function runElapsed(state: AppState, now: number): string | undefined {
  if (state.runStartedAt === undefined) return undefined;
  return elapsed(now - state.runStartedAt);
}

export interface PlanProgress {
  readonly done: number;
  readonly total: number;
  readonly active?: PlanStep;
}

export function planProgress(plan: readonly PlanStep[]): PlanProgress {
  const active = plan.find((step) => step.status === 'active');
  return {
    done: plan.filter((step) => step.status === 'done').length,
    total: plan.length,
    ...(active !== undefined ? { active } : {}),
  };
}

export interface AgentProgress {
  readonly total: number;
  readonly working: number;
  readonly done: number;
  readonly failed: number;
}

export function agentProgress(state: AppState): AgentProgress {
  return {
    total: state.agents.length,
    working: state.agents.filter((a) => a.status === 'working' || a.status === 'spawned').length,
    done: state.agents.filter((a) => a.status === 'done').length,
    failed: state.agents.filter((a) => a.status === 'error').length,
  };
}

/**
 * A one-line route summary for the status bar, or undefined when the gateway
 * has not told us anything yet. Never says "unknown" in the status line — a
 * field with nothing behind it is simply absent.
 */
export function routeSummary(state: AppState): string | undefined {
  const route = state.route.current;
  if (route === undefined) return undefined;
  const name = route.provider ?? route.model;
  if (name === undefined) return undefined;
  return route.fallback ? `${name} (failover)` : name;
}

/** Label / value pairs for the route lens, measured values only. */
export interface Field { readonly label: string; readonly value: string }

export function routeFields(state: AppState): readonly Field[] {
  const route = state.route.current;
  const out: Field[] = [];
  out.push({ label: 'engine', value: state.session.model });
  if (route?.provider !== undefined) out.push({ label: 'provider', value: route.provider });
  if (route?.model !== undefined) out.push({ label: 'model', value: route.model });
  if (route?.strategy !== undefined) out.push({ label: 'profile', value: route.strategy });
  if (route !== undefined && route.attempts > 0) {
    out.push({ label: 'attempts', value: String(route.attempts + 1) });
  }
  if (route?.reason !== undefined) out.push({ label: 'reason', value: route.reason });
  const latency = millis(route?.latencyMs ?? state.usage.latencyMs);
  if (latency !== undefined) out.push({ label: 'latency', value: latency });
  if (state.route.cooldownUntil !== undefined) {
    out.push({ label: 'cooldown', value: state.route.cooldownUntil });
  }
  return out;
}

/**
 * Usage rows for the route lens. Only figures the gateway reported appear; a
 * session where nothing was measured shows no usage section at all, rather
 * than a column of zeroes that would read as "free and instant".
 */
export function usageFields(state: AppState): readonly Field[] {
  const out: Field[] = [];
  const { usage } = state;
  const tin = tokens(usage.tokensIn);
  const tout = tokens(usage.tokensOut);
  if (tin !== undefined || tout !== undefined) {
    out.push({
      label: 'tokens',
      value: [tin !== undefined ? `${tin} in` : undefined, tout !== undefined ? `${tout} out` : undefined]
        .filter((part): part is string => part !== undefined)
        .join(' · '),
    });
  }
  const spend = cost(usage.costUsd);
  if (spend !== undefined) out.push({ label: 'cost', value: spend });
  if (usage.requests !== undefined && usage.requests > 0) out.push({ label: 'calls', value: String(usage.requests) });
  if (usage.compression !== undefined) {
    const saved = tokens(usage.compression.savedTokens);
    out.push({
      label: 'compressed',
      value: `${Math.round(usage.compression.savedFraction * 100)}% saved`
        + (saved !== undefined ? ` (${saved} tokens)` : '')
        + (usage.compression.strategy !== '' ? ` · ${usage.compression.strategy.toUpperCase()}` : ''),
    });
  }
  if (usage.remainingQuota !== undefined) out.push({ label: 'quota', value: String(usage.remainingQuota) });
  return out;
}

/**
 * The context meter, or undefined when no completion has reported prompt
 * tokens yet. Sized to whatever model actually answered when the gateway named
 * one — an `auto/*` engine can land anywhere, and the window is that model's.
 */
export function contextUse(state: AppState, windows: WindowIndex): ContextMeter | undefined {
  const used = state.usage.contextTokens;
  if (used === undefined || used <= 0) return undefined;
  return contextMeter(used, state.route.current?.model ?? state.session.model, state.route.current?.provider, windows);
}

/** Failover attempts in this session, newest first. Empty is the normal case. */
export function fallbackHistory(state: AppState): readonly RouteDecision[] {
  return [...state.route.history].filter((decision) => decision.fallback).reverse();
}

/**
 * Every tool call in this session, newest first: the ones still in the live
 * region and then the ones already in scrollback. Views that summarise the
 * session (the plan lens, an agent's calls) need both halves.
 */
export function toolHistory(state: AppState): readonly ToolRecord[] {
  const out: ToolRecord[] = [...state.live.tools].reverse();
  for (let i = state.transcript.length - 1; i >= 0; i -= 1) {
    const entry = state.transcript[i]!;
    if (entry.kind === 'tool') out.push(entry.tool);
  }
  return out;
}

/** Whether the wide-terminal rail has anything worth showing. */
export function railHasContent(state: AppState): boolean {
  return state.plan.length > 0 || state.agents.length > 0 || state.route.current !== undefined;
}
