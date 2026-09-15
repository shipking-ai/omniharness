/**
 * The plan lens — the whole strategy, not the three-row digest the run lens
 * can afford.
 *
 * Every step, in order, with its state; the active one highlighted; and beneath
 * it what the plan has actually cost so far in calls and failures. The harness
 * derives the plan — the point of this view is to make what it derived legible
 * enough to trust, not to let it be edited from here.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { clip } from '../format/clip.js';
import { Heading, Marker } from '../components/atoms.js';
import { PlanRow } from './run.js';
import { planProgress, toolHistory } from '../state/selectors.js';
import type { Glyphs, Theme } from '../theme/tokens.js';
import type { AppState } from '../state/types.js';

export interface StrategyViewProps {
  readonly state: AppState;
  readonly width: number;
  readonly rows: number;
  readonly theme: Theme;
  readonly glyphs: Glyphs;
}

export function StrategyView({ state, width, rows, theme, glyphs }: StrategyViewProps): React.ReactElement {
  const progress = planProgress(state.plan);
  const calls = toolHistory(state);
  const failures = calls.filter((tool) => tool.outcome === 'error');
  const denied = calls.filter((tool) => tool.outcome === 'denied');

  if (state.plan.length === 0) {
    return <Box flexDirection="column" marginTop={1}>
      <Heading theme={theme}>plan</Heading>
      <Text color={theme.muted}>
        no plan yet - the harness writes one as it works out what the task needs
      </Text>
      {calls.length > 0
        ? <Text color={theme.muted}>{calls.length} tool call{calls.length === 1 ? '' : 's'} so far</Text>
        : null}
    </Box>;
  }

  const listRows = Math.max(1, rows - 4);

  return <Box flexDirection="column" marginTop={1}>
    <Box flexDirection="row" justifyContent="space-between" width={width}>
      <Heading theme={theme}>plan</Heading>
      <Text color={theme.muted}>{progress.done}/{progress.total} done</Text>
    </Box>

    {state.plan.slice(0, listRows).map((step) => (
      <PlanRow key={step.id} step={step} width={width} theme={theme} glyphs={glyphs} />
    ))}
    {state.plan.length > listRows
      ? <Text color={theme.muted}>{'  '}+{state.plan.length - listRows} more steps</Text>
      : null}

    {failures.length > 0 || denied.length > 0
      ? <Box flexDirection="column" marginTop={1}>
          <Heading theme={theme}>blocked</Heading>
          {failures.slice(0, 3).map((tool) => (
            <Text key={tool.id}>
              <Marker state="failed" glyphs={glyphs} theme={theme} />
              <Text color={theme.error}>{clip(`${tool.verb} ${tool.target || tool.name}`, Math.max(8, width - 2))}</Text>
            </Text>
          ))}
          {denied.slice(0, 3).map((tool) => (
            <Text key={tool.id}>
              <Marker state="denied" glyphs={glyphs} theme={theme} />
              <Text color={theme.warn}>{clip(`${tool.verb} ${tool.target || tool.name} - you declined`, Math.max(8, width - 2))}</Text>
            </Text>
          ))}
        </Box>
      : null}
  </Box>;
}
