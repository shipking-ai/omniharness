/**
 * The agents lens — what is running in parallel, and what each worker is on.
 *
 * A swarm's value is that several things happen at once, and the run lens can
 * only afford three rows of that. Here every lane is listed with its state and
 * its latest note, and the selected lane expands to the calls it has made.
 *
 * Nothing is invented: a worker that has reported no note shows its label, and
 * a session with no workers says so in one line rather than drawing an empty
 * table.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { clip } from '../format/clip.js';
import { elapsed } from '../format/units.js';
import { Heading, Marker, joinMeta, type MarkerState } from '../components/atoms.js';
import { ToolBlock } from '../components/transcript.js';
import { agentProgress, toolHistory } from '../state/selectors.js';
import type { Glyphs, Theme } from '../theme/tokens.js';
import type { AgentRecord, AppState } from '../state/types.js';

export function agentMarker(status: AgentRecord['status']): MarkerState {
  switch (status) {
    case 'spawned': return 'waiting';
    case 'working': return 'running';
    case 'done': return 'done';
    case 'error': return 'failed';
  }
}

export interface AgentsViewProps {
  readonly state: AppState;
  readonly width: number;
  readonly rows: number;
  readonly theme: Theme;
  readonly glyphs: Glyphs;
  readonly now: number;
}

export function AgentsView({ state, width, rows, theme, glyphs, now }: AgentsViewProps): React.ReactElement {
  const progress = agentProgress(state);

  if (state.agents.length === 0) {
    return <Box flexDirection="column" marginTop={1}>
      <Heading theme={theme}>agents</Heading>
      <Text color={theme.muted}>
        no parallel workers in this session - crazy mode fans a plan out across them
      </Text>
    </Box>;
  }

  const selected = state.agents[Math.min(state.lensCursor, state.agents.length - 1)];
  const listRows = Math.max(1, Math.min(state.agents.length, rows - 4));
  const calls = selected === undefined
    ? []
    : toolHistory(state).filter((tool) => tool.agentId === selected.id).slice(0, Math.max(0, rows - listRows - 3));

  return <Box flexDirection="column" marginTop={1}>
    <Box flexDirection="row" justifyContent="space-between" width={width}>
      <Heading theme={theme}>agents</Heading>
      <Text color={theme.muted}>{joinMeta([
        progress.working > 0 ? `${progress.working} working` : undefined,
        progress.done > 0 ? `${progress.done} done` : undefined,
        progress.failed > 0 ? `${progress.failed} failed` : undefined,
      ], glyphs.dot)}</Text>
    </Box>

    {state.agents.slice(0, listRows).map((agent, index) => {
      const focused = agent.id === selected?.id;
      return <Text key={agent.id}>
        <Text color={focused ? theme.accent : undefined}>{focused ? glyphs.selected : ' '} </Text>
        <Marker state={agentMarker(agent.status)} glyphs={glyphs} theme={theme} />
        <Text bold={focused}>{clip(agent.id, 8).padEnd(8)}</Text>
        <Text color={theme.muted}>
          {clip(agent.note ?? agent.label, Math.max(8, width - 24))}
        </Text>
        <Text color={theme.muted}>{'  '}{elapsed((agent.status === 'done' ? agent.updatedAt : now) - agent.startedAt)}</Text>
        {index >= listRows ? null : null}
      </Text>;
    })}
    {state.agents.length > listRows
      ? <Text color={theme.muted}>{'  '}+{state.agents.length - listRows} more</Text>
      : null}

    {selected !== undefined && calls.length > 0
      ? <Box flexDirection="column" marginTop={1}>
          <Heading theme={theme}>{`${selected.id} ${glyphs.dot} recent calls`}</Heading>
          {calls.map((tool) => (
            <ToolBlock key={tool.id} tool={tool} width={width} theme={theme} glyphs={glyphs} />
          ))}
        </Box>
      : null}
  </Box>;
}
