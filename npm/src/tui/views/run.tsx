/**
 * The run lens — the default view, and the one the interface is designed
 * around.
 *
 * Reading order, top to bottom: what the model is saying, what it is doing
 * right now, and how far through the plan it is. Settled turns are already in
 * scrollback above; this region holds only what is still moving, so the text
 * the user is reading does not get redrawn underneath them while it streams.
 *
 * Everything here is budgeted. `streamRows` and `lensRows` come from the height
 * plan, and each section takes what it is given rather than what it would like
 * — a frame taller than the viewport makes Ink's redraw eat the transcript.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { clip } from '../format/clip.js';
import { Heading, Marker, joinMeta } from '../components/atoms.js';
import { Prose } from '../components/prose.js';
import { ToolBlock } from '../components/transcript.js';
import { agentProgress, planProgress } from '../state/selectors.js';
import type { Glyphs, Theme } from '../theme/tokens.js';
import type { AppState, PlanStep } from '../state/types.js';

export interface RunViewProps {
  readonly state: AppState;
  readonly width: number;
  readonly theme: Theme;
  readonly glyphs: Glyphs;
  readonly streamRows: number;
  readonly lensRows: number;
  /** Narrow terminals drop the plan and agent digests entirely. */
  readonly compact: boolean;
  /**
   * Whether the rail is drawing the plan and the workers beside this view.
   *
   * When it is, this view must not draw them as well. It did, and a terminal
   * wide enough for a rail showed the same plan twice, side by side, with the
   * two copies windowed to different heights.
   */
  readonly railed: boolean;
}

/**
 * Calls in flight shown at once before the rest are counted instead of listed.
 * A finished call is already in the transcript above, so this only ever holds
 * work that is genuinely still running.
 */
const MAX_CALLS = 6;

export function RunView({
  state, width, theme, glyphs, streamRows, lensRows, compact, railed,
}: RunViewProps): React.ReactElement | null {
  // `reasoning` is read for whether the model is thinking, never for what it is
  // thinking. The status line says "thinking"; the content stays internal.
  const { reasoning, answer, tools } = state.live;
  const answerRows = Math.max(1, streamRows);

  const recent = tools.slice(-MAX_CALLS);
  const hidden = tools.length - recent.length;

  const plan = planProgress(state.plan);
  const agents = agentProgress(state);
  // A narrow terminal cannot hold the lists, but "what is it doing" is exactly
  // what it most needs to answer — so the plan collapses to one line rather
  // than disappearing, which is what it used to do.
  const wantPlan = !railed && !compact && state.plan.length > 0 && lensRows >= 2;
  const wantPlanLine = !railed && compact && state.plan.length > 0;
  const wantAgents = !railed && !compact && agents.total > 0 && lensRows >= 4;

  const empty = answer === '' && tools.length === 0
    && !wantPlan && !wantPlanLine && !wantAgents;
  if (empty) return null;

  return <Box flexDirection="column">
    {answer !== ''
      ? <Box flexDirection="column">
          <Prose ascii={glyphs.ascii} text={answer} width={width} limit={answerRows} />
        </Box>
      : null}

    {recent.length > 0
      ? <Box flexDirection="column" marginTop={1}>
          {recent.map((tool) => (
            <ToolBlock key={tool.id} tool={tool} width={width} theme={theme} glyphs={glyphs} />
          ))}
          {hidden > 0 ? <Text color={theme.muted}>{'  '}+{hidden} more running</Text> : null}
        </Box>
      : null}

    {wantPlanLine
      ? <Text color={theme.muted}>
          {'\n'}plan {plan.done}/{plan.total}
          {plan.active !== undefined
            ? ` ${glyphs.dot} ${clip(plan.active.title, Math.max(8, width - 14))}`
            : ''}
        </Text>
      : null}

    {wantPlan
      ? <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row" justifyContent="space-between" width={width}>
            <Heading theme={theme}>plan</Heading>
            <Text color={theme.muted}>{plan.done}/{plan.total}</Text>
          </Box>
          {visibleSteps(state.plan, Math.max(1, Math.min(6, lensRows - (wantAgents ? 4 : 1)))).map((step) => (
            <PlanRow key={step.id} step={step} width={width} theme={theme} glyphs={glyphs} />
          ))}
        </Box>
      : null}

    {wantAgents
      ? <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row" justifyContent="space-between" width={width}>
            <Heading theme={theme}>agents</Heading>
            <Text color={theme.muted}>{joinMeta([
              agents.working > 0 ? `${agents.working} working` : undefined,
              agents.done > 0 ? `${agents.done} done` : undefined,
              agents.failed > 0 ? `${agents.failed} failed` : undefined,
            ], glyphs.dot)}</Text>
          </Box>
          {state.agents.slice(0, 3).map((agent) => (
            <Text key={agent.id}>
              <Marker
                state={agent.status === 'done' ? 'done' : agent.status === 'error' ? 'failed' : 'running'}
                glyphs={glyphs}
                theme={theme}
              />
              <Text>{clip(agent.id, 6).padEnd(6)}</Text>
              <Text color={theme.muted}>{clip(agent.note ?? agent.label, Math.max(8, width - 10))}</Text>
            </Text>
          ))}
        </Box>
      : null}
  </Box>;
}

/**
 * The window of the plan worth showing inline: the active step, with what came
 * just before it and what comes next. A long plan scrolled off the top is the
 * part already done, which is the part nobody is looking for.
 */
export function visibleSteps(plan: readonly PlanStep[], limit: number): readonly PlanStep[] {
  if (plan.length <= limit) return plan;
  const active = plan.findIndex((step) => step.status === 'active');
  if (active < 0) {
    const firstPending = plan.findIndex((step) => step.status === 'pending');
    const anchor = firstPending < 0 ? plan.length - limit : Math.max(0, firstPending - 1);
    return plan.slice(anchor, anchor + limit);
  }
  const start = Math.min(Math.max(0, active - 1), Math.max(0, plan.length - limit));
  return plan.slice(start, start + limit);
}

export function PlanRow({
  step, width, theme, glyphs,
}: { step: PlanStep; width: number; theme: Theme; glyphs: Glyphs }): React.ReactElement {
  return <Text>
    <Marker
      state={step.status === 'done' ? 'done' : step.status === 'active' ? 'running' : 'pending'}
      glyphs={glyphs}
      theme={theme}
    />
    <Text
      color={step.status === 'active' ? theme.text : theme.muted}
      dimColor={step.status === 'done'}
    >{clip(step.title, Math.max(8, width - 2))}</Text>
  </Text>;
}
