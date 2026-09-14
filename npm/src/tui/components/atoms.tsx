/**
 * The smallest shared pieces of the interface.
 *
 * Everything visual is built from these, which is what keeps the design
 * consistent without a component framework: one way to write a heading, one
 * way to write a label, one status marker, one meter. Each is a thin wrapper
 * over Ink's `Text` — there is no styling engine here and there should not be.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { clip } from '../format/clip.js';
import type { Glyphs, Theme } from '../theme/tokens.js';

/**
 * Width of the dim label column, including the gap before the value. Wide
 * enough for the longest label plus a separator: at an exact fit the label
 * and its value collide ("compressed40% saved"), which is how the old
 * interface rendered its longest row.
 */
export const LABEL_WIDTH = 12;

export function Heading({ children, theme }: { children: string; theme: Theme }): React.ReactElement {
  return <Text bold color={theme.muted}>{children}</Text>;
}

/** A dim fixed-width label followed by its value. */
export function Field({
  label, value, theme, width, color,
}: { label: string; value: string; theme: Theme; width: number; color?: string }): React.ReactElement {
  return <Text>
    <Text color={theme.muted}>{clip(label, LABEL_WIDTH - 1).padEnd(LABEL_WIDTH)}</Text>
    <Text color={color}>{clip(value, Math.max(4, width - LABEL_WIDTH))}</Text>
  </Text>;
}

/** A horizontal rule. Used once, above the composer; not as decoration. */
export function Rule({
  width, theme, glyphs,
}: { width: number; theme: Theme; glyphs: Glyphs }): React.ReactElement {
  return <Text color={theme.muted}>{glyphs.hrule.repeat(Math.max(1, width))}</Text>;
}

export type MarkerState = 'running' | 'done' | 'pending' | 'waiting' | 'failed' | 'denied';

export function markerGlyph(state: MarkerState, glyphs: Glyphs): string {
  switch (state) {
    case 'running': return glyphs.running;
    case 'done': return glyphs.done;
    case 'pending': return glyphs.pending;
    case 'waiting': return glyphs.waiting;
    case 'failed': return glyphs.failed;
    case 'denied': return glyphs.denied;
  }
}

export function markerColor(state: MarkerState, theme: Theme): string | undefined {
  switch (state) {
    case 'running': return theme.active;
    case 'done': return theme.success;
    case 'pending': return theme.muted;
    case 'waiting': return theme.muted;
    case 'failed': return theme.error;
    case 'denied': return theme.warn;
  }
}

/**
 * A status marker in a fixed-width column, so descriptions line up down the
 * page however the calls turned out. Two columns: the glyph and its gap.
 */
export function Marker({
  state, glyphs, theme,
}: { state: MarkerState; glyphs: Glyphs; theme: Theme }): React.ReactElement {
  return <Text color={markerColor(state, theme)}>{markerGlyph(state, glyphs)} </Text>;
}

/** A compact fill bar. `cells` columns wide, no percentage of its own. */
export function meterBar(fraction: number, cells: number, glyphs: Glyphs): string {
  const clamped = Math.min(1, Math.max(0, fraction));
  const filled = Math.round(clamped * cells);
  return `${glyphs.meterFull.repeat(filled)}${glyphs.meterEmpty.repeat(Math.max(0, cells - filled))}`;
}

/**
 * A vertical rule down the left edge of a block, rather than a box on four
 * sides — a full border around every tool result turns a transcript into a
 * stack of crates.
 *
 * It is Ink's own left border and not a prefixed `Text`, because a Text beside
 * a column only ever draws one row: the rule appeared next to the first line of
 * output and nowhere else. Ink's border is drawn down the whole height.
 */
export function Gutter({
  children, theme, ascii,
}: { children: React.ReactNode; theme: Theme; ascii: boolean }): React.ReactElement {
  return <Box
    flexDirection="column"
    borderStyle={ascii ? 'classic' : 'single'}
    borderColor={theme.muted}
    borderTop={false}
    borderRight={false}
    borderBottom={false}
    paddingLeft={1}
  >{children}</Box>;
}

/** Metadata joined by a separator, skipping anything that was not measured. */
export function joinMeta(parts: readonly (string | undefined)[], separator: string): string {
  return parts.filter((part): part is string => part !== undefined && part !== '').join(` ${separator} `);
}
