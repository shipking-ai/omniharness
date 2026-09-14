/**
 * The secondary column, on wide terminals only.
 *
 * It exists to use space that would otherwise be empty, so it is only drawn
 * when it has something to say: no plan, no workers and no route decision means
 * no rail, and the reading column gets the width back. Filling a wide terminal
 * with labelled empty panels is the failure mode this guards against.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { clip } from '../format/clip.js';
import { millis } from '../format/units.js';
import { Heading, Marker, meterBar } from './atoms.js';
import { agentMarker } from '../views/agents.js';
import { visibleSteps } from '../views/run.js';
import { agentProgress, contextUse, planProgress } from '../state/selectors.js';
import type { WindowIndex } from '../format/context.js';
import type { Glyphs, Theme } from '../theme/tokens.js';
import type { AppState } from '../state/types.js';

export interface RailProps {
  readonly state: AppState;
  readonly width: number;
  readonly rows: number;
  readonly theme: Theme;
  readonly glyphs: Glyphs;
  readonly windows: WindowIndex;
}

export function Rail({ state, width, rows, theme, glyphs, windows }: RailProps): React.ReactElement | null {
  const plan = planProgress(state.plan);
  const agents = agentProgress(state);
  const route = state.route.current;
  const meter = contextUse(state, windows);
  if (plan.total === 0 && agents.total === 0 && route === undefined) return null;

  const inner = Math.max(10, width - 1);
  const planRows = plan.total === 0 ? 0 : Math.max(1, Math.min(plan.total, Math.floor((rows - 6) / 2)));

  return <Box flexDirection="column" width={width}>
    {plan.total > 0
      ? <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" width={inner}>
            <Heading theme={theme}>plan</Heading>
            <Text color={theme.muted}>{plan.done}/{plan.total}</Text>
          </Box>
          {visibleSteps(state.plan, planRows).map((step) => (
            <Text key={step.id}>
              <Marker
                state={step.status === 'done' ? 'done' : step.status === 'active' ? 'running' : 'pending'}
                glyphs={glyphs}
                theme={theme}
              />
              <Text color={step.status === 'active' ? theme.text : theme.muted} dimColor={step.status === 'done'}>
                {clip(step.title, inner - 2)}
              </Text>
            </Text>
          ))}
        </Box>
      : null}

    {agents.total > 0
      ? <Box flexDirection="column" marginTop={plan.total > 0 ? 1 : 0}>
          <Box flexDirection="row" justifyContent="space-between" width={inner}>
            <Heading theme={theme}>agents</Heading>
            <Text color={theme.muted}>{agents.done}/{agents.total}</Text>
          </Box>
          {state.agents.slice(0, 4).map((agent) => (
            <Text key={agent.id}>
              <Marker state={agentMarker(agent.status)} glyphs={glyphs} theme={theme} />
              <Text color={theme.muted}>{clip(agent.note ?? agent.label, inner - 2)}</Text>
            </Text>
          ))}
        </Box>
      : null}

    {route !== undefined
      ? <Box flexDirection="column" marginTop={1}>
          <Heading theme={theme}>route</Heading>
          {route.provider !== undefined
            ? <Text color={route.fallback ? theme.warn : theme.muted}>
                {clip(route.fallback ? `${route.provider} (failover)` : route.provider, inner)}
              </Text>
            : null}
          {route.model !== undefined ? <Text color={theme.muted}>{clip(route.model, inner)}</Text> : null}
          {route.strategy !== undefined ? <Text color={theme.muted}>{clip(route.strategy, inner)}</Text> : null}
          {millis(route.latencyMs) !== undefined
            ? <Text color={theme.muted}>{millis(route.latencyMs)}</Text>
            : null}
          {meter !== undefined
            ? <Text color={meter.zone === 'danger' ? theme.error : meter.zone === 'warn' ? theme.warn : theme.muted}>
                {meterBar(meter.fraction, Math.min(12, inner - 5), glyphs)} {Math.round(meter.fraction * 100)}%
              </Text>
            : null}
        </Box>
      : null}
  </Box>;
}
