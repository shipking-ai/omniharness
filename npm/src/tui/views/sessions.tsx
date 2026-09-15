/**
 * The sessions lens — saved snapshots of this workspace, newest first.
 *
 * Resume is the point of it, so Enter resumes and the rest is metadata. The
 * list is read from disk on entry rather than cached at startup: a snapshot
 * written by another window in the same workspace should appear here without a
 * restart.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { clip } from '../format/clip.js';
import { since } from '../format/units.js';
import { Heading } from '../components/atoms.js';
import type { Glyphs, Theme } from '../theme/tokens.js';
import type { AppState } from '../state/types.js';

export interface SessionsViewProps {
  readonly state: AppState;
  readonly width: number;
  readonly rows: number;
  readonly theme: Theme;
  readonly glyphs: Glyphs;
  readonly now: number;
}

export function SessionsView({ state, width, rows, theme, glyphs, now }: SessionsViewProps): React.ReactElement {
  const saved = state.session.saved;

  if (saved.length === 0) {
    return <Box flexDirection="column" marginTop={1}>
      <Heading theme={theme}>sessions</Heading>
      <Text color={theme.muted}>no saved sessions in this workspace - /save {'<name>'} snapshots this one</Text>
    </Box>;
  }

  const listRows = Math.max(1, Math.min(saved.length, rows - 3));

  return <Box flexDirection="column" marginTop={1}>
    <Box flexDirection="row" justifyContent="space-between" width={width}>
      <Heading theme={theme}>sessions</Heading>
      <Text color={theme.muted}>
        {saved.length} saved
        {state.session.resumedFrom !== undefined ? ` ${glyphs.dot} on ${state.session.resumedFrom}` : ''}
      </Text>
    </Box>

    {saved.slice(0, listRows).map((session, index) => {
      const focused = index === Math.min(state.lensCursor, saved.length - 1);
      const age = since(session.savedAt, now);
      return <Text key={session.name}>
        <Text color={focused ? theme.accent : undefined}>{focused ? glyphs.selected : ' '} </Text>
        <Text bold={focused}>{clip(session.name, Math.max(8, width - 16)).padEnd(Math.max(8, Math.min(28, width - 16)))}</Text>
        <Text color={theme.muted}>{age}</Text>
      </Text>;
    })}
    {saved.length > listRows
      ? <Text color={theme.muted}>{'  '}+{saved.length - listRows} more</Text>
      : null}
  </Box>;
}
