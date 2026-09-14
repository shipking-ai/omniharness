/**
 * The secondary column, on terminals wide enough to hold one beside the full
 * reading measure.
 *
 * It carries *work* — the plan and the workers — and nothing else. Routing
 * telemetry used to live here too, and a permanent five-row provider/model/
 * latency panel is exactly the monitoring dashboard this interface is not: the
 * status line already says which provider answered, and the route lens has the
 * detail for the moment anyone actually wants it.
 *
 * It is drawn only when it has something to say, so an ordinary conversational
 * turn on a wide terminal shows no empty labelled panel.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { clip } from '../format/clip.js';
import { Heading, Marker } from './atoms.js';
import { agentMarker } from '../views/agents.js';
import { visibleSteps } from '../views/run.js';
import { agentProgress, planProgress } from '../state/selectors.js';
import type { Glyphs, Theme } from '../theme/tokens.js';
import type { AppState } from '../state/types.js';

export interface RailProps {
  readonly state: AppState;
  readonly width: number;
  readonly rows: number;
  readonly theme: Theme;
  readonly glyphs: Glyphs;
}

export function Rail({ state, width, rows, theme, glyphs }: RailProps): React.ReactElement | null {
  const plan = planProgress(state.plan);
  const agents = agentProgress(state);
  if (plan.total === 0 && agents.total === 0) return null;

  const inner = Math.max(10, width - 1);
  const planRows = plan.total === 0 ? 0 : Math.max(1, Math.min(plan.total, Math.max(2, rows - 8)));

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
  </Box>;
}
