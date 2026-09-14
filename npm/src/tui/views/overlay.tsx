/**
 * The two modal lists: the command palette and the engine picker.
 *
 * They are one interaction — filter, move, choose — so they are one component
 * with two data sources. The palette is the discovery surface for everything
 * this interface can do; nothing is reachable only by a shortcut nobody has
 * been told about.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { clip } from '../format/clip.js';
import { Heading } from '../components/atoms.js';
import { search } from '../commands/registry.js';
import type { Glyphs, Theme } from '../theme/tokens.js';
import type { AppState, Overlay } from '../state/types.js';

export interface OverlayViewProps {
  readonly overlay: Overlay;
  readonly state: AppState;
  readonly width: number;
  readonly rows: number;
  readonly theme: Theme;
  readonly glyphs: Glyphs;
}

export function OverlayView({ overlay, state, width, rows, theme, glyphs }: OverlayViewProps): React.ReactElement {
  return overlay.kind === 'palette'
    ? <PaletteList overlay={overlay} width={width} rows={rows} theme={theme} glyphs={glyphs} />
    : <ModelList overlay={overlay} state={state} width={width} rows={rows} theme={theme} glyphs={glyphs} />;
}

/**
 * The window of a list to draw so the selection is always on screen, without
 * the list jumping a page at a time as the cursor crosses the boundary.
 */
export function windowAround(index: number, total: number, capacity: number): { start: number; end: number } {
  if (total <= capacity) return { start: 0, end: total };
  const half = Math.floor(capacity / 2);
  const start = Math.min(Math.max(0, index - half), total - capacity);
  return { start, end: start + capacity };
}

function PaletteList({
  overlay, width, rows, theme, glyphs,
}: {
  overlay: Extract<Overlay, { kind: 'palette' }>;
  width: number; rows: number; theme: Theme; glyphs: Glyphs;
}): React.ReactElement {
  const matches = search(overlay.query);
  const capacity = Math.max(1, rows - 2);
  const { start, end } = windowAround(overlay.index, matches.length, capacity);

  return <Box flexDirection="column" marginTop={1}>
    <Box flexDirection="row" justifyContent="space-between" width={width}>
      <Text color={theme.accent} bold>{glyphs.caret} {overlay.query === '' ? 'commands' : overlay.query}</Text>
      <Text color={theme.muted}>{matches.length} match{matches.length === 1 ? '' : 'es'}</Text>
    </Box>
    {matches.length === 0
      ? <Text color={theme.muted}>nothing matches — esc to close</Text>
      : matches.slice(start, end).map((command, offset) => {
          const focused = start + offset === overlay.index;
          const name = `/${command.name}${command.argument !== undefined ? ` ${command.argument}` : ''}`;
          const nameWidth = Math.min(24, Math.max(10, Math.floor(width * 0.3)));
          return <Text key={command.id}>
            <Text color={focused ? theme.accent : undefined}>{focused ? glyphs.selected : ' '} </Text>
            <Text color={focused ? theme.accent : theme.muted}>{clip(name, nameWidth).padEnd(nameWidth)}</Text>
            <Text bold={focused}>{clip(command.title, Math.max(8, width - nameWidth - 4))}</Text>
          </Text>;
        })}
    {matches.length > capacity
      ? <Text color={theme.muted}>{'  '}{matches.length - capacity} more — keep typing to narrow</Text>
      : null}
  </Box>;
}

function ModelList({
  overlay, state, width, rows, theme, glyphs,
}: {
  overlay: Extract<Overlay, { kind: 'models' }>;
  state: AppState; width: number; rows: number; theme: Theme; glyphs: Glyphs;
}): React.ReactElement {
  if (overlay.loading) {
    return <Box flexDirection="column" marginTop={1}>
      <Heading theme={theme}>engines</Heading>
      <Text color={theme.muted}>asking OmniRoute…</Text>
    </Box>;
  }
  if (overlay.error !== undefined) {
    return <Box flexDirection="column" marginTop={1}>
      <Heading theme={theme}>engines</Heading>
      <Text color={theme.error}>{clip(overlay.error, width)}</Text>
      <Text color={theme.muted}>check that OmniRoute is running at {state.session.endpoint}</Text>
    </Box>;
  }
  if (overlay.items.length === 0) {
    return <Box flexDirection="column" marginTop={1}>
      <Heading theme={theme}>engines</Heading>
      <Text color={theme.muted}>OmniRoute returned no combos or auto routes</Text>
    </Box>;
  }

  const capacity = Math.max(1, rows - 2);
  const { start, end } = windowAround(overlay.index, overlay.items.length, capacity);
  let lastGroup = start > 0 ? overlay.items[start - 1]?.group : undefined;

  return <Box flexDirection="column" marginTop={1}>
    <Heading theme={theme}>engines</Heading>
    {overlay.items.slice(start, end).map((item, offset) => {
      const focused = start + offset === overlay.index;
      const heading = item.group !== lastGroup ? item.group : undefined;
      lastGroup = item.group;
      return <Box key={item.id} flexDirection="column">
        {heading !== undefined ? <Text color={theme.muted} bold>{heading}</Text> : null}
        <Text>
          <Text color={focused ? theme.accent : undefined}>{focused ? glyphs.selected : ' '} </Text>
          <Text bold={focused}>{clip(item.id, Math.max(10, width - 24))}</Text>
          {item.detail !== undefined ? <Text color={theme.muted}>{'  '}{clip(item.detail, 18)}</Text> : null}
          {item.id === state.session.model ? <Text color={theme.success}>{'  '}current</Text> : null}
        </Text>
      </Box>;
    })}
  </Box>;
}
