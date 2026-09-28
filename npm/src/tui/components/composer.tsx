/**
 * The composer.
 *
 * A filled block with a spine down its left edge, and under the text, inside
 * the block, the settings the next task will run with: the mode, the model and
 * how freely it may act. This is the composer OpenCode and Kilo draw, and the
 * reason is the same one that makes theirs read well: a surface a shade off the
 * background marks "type here" without a box, and putting the mode and model in
 * the input rather than in a footer is what makes them read as the settings of
 * this task instead of as status.
 *
 * No border: a box around the input competes with the answer above it for the
 * eye, and at narrow widths it costs columns the text needs. The spine carries
 * the state instead — it takes the mode's colour, and turns red when the last
 * run failed. Where the terminal cannot be trusted with a background (no
 * truecolor, NO_COLOR) the block is the spine alone, which is what it was.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { layoutEditor } from '../input/editor.js';
import { clip } from '../format/clip.js';

import { completions } from '../commands/slash.js';
import { joinMeta } from './atoms.js';
import type { Band } from '../layout/frame.js';
import type { Glyphs, Theme } from '../theme/tokens.js';
import type { AgentMode } from '../../types/index.js';
import type { ComposerState, Phase } from '../state/types.js';

export interface ComposerProps {
  readonly composer: ComposerState;
  readonly width: number;
  readonly mode: AgentMode;
  readonly phase: Phase;
  readonly theme: Theme;
  readonly glyphs: Glyphs;
  readonly failed: boolean;
  /** The model the next task will be sent to. */
  readonly model?: string;
  /** How approvals are handled, and the colour that setting deserves. */
  readonly permission?: { readonly label: string; readonly color: string };
  readonly band?: Band;
  /**
   * Columns the fill spans: the whole frame, like the user's task band and the
   * status line under it. The text still wraps at `width`, the reading measure.
   */
  readonly span?: number;
}

/** Mode accents. Colour here means "what this session will do", nothing else. */
export function modeColor(mode: AgentMode, theme: Theme): string {
  switch (mode) {
    case 'plan': return theme.accent;
    case 'build': return theme.success;
    case 'research': return theme.active;
    case 'crazy': return theme.error;
  }
}

/** Columns the composer text itself gets, once the spine and padding are taken. */
export const composerTextWidth = (width: number): number => Math.max(12, width - 3);

/**
 * Rows the composer draws beyond the text itself: the settings row. The height
 * plan needs it, because a frame one row taller than it planned for is the one
 * thing that makes Ink's redraw eat the transcript.
 */
export const COMPOSER_EXTRA_ROWS = 1;

export function Composer({
  composer, width, mode, phase, theme, glyphs, failed, model, permission, band, span,
}: ComposerProps): React.ReactElement {
  const textWidth = composerTextWidth(width);
  const fill = Math.max(width, span ?? width);
  // The settings row is laid out across the fill, so its right-hand setting
  // lines up with the right-hand end of the status line under it.
  const settingsWidth = Math.max(textWidth, fill - 3);
  const spineColor = failed ? theme.error : modeColor(mode, theme);
  const layout = layoutEditor(composer.value, composer.cursor, textWidth);
  const matches = completions(composer.value);
  const surface = theme.surface;

  // One row of the block: spine, a space, the content, padded to the full
  // width so the fill is a rectangle rather than a ragged edge. Each row is its
  // own Text because a Text beside a column only draws its first row.
  const row = (key: string | number, content: React.ReactNode, used: number): React.ReactElement => (
    <Text key={key} backgroundColor={surface}>
      <Text color={spineColor}>{glyphs.spine}</Text>
      {' '}{content}{' '.repeat(Math.max(0, fill - 2 - used))}
    </Text>
  );

  const lines: React.ReactElement[] = [];
  if (composer.value === '') {
    const hint = phase === 'idle' ? 'describe the work, or / for a command' : 'type to queue the next task';
    lines.push(row('hint', <Text color={theme.muted} dimColor>{clip(hint, textWidth)}</Text>, Math.min(hint.length, textWidth)));
  } else {
    layout.lines.forEach((line, index) => {
      lines.push(row(index, <Text color={theme.text}>{line}</Text>, [...line].length));
    });
  }

  // Completion is offered, never applied on its own: the list appears as soon
  // as the text looks like a command, and Tab takes the first.
  if (matches.length > 0 && composer.value.trim() !== '/') {
    const list = clip(matches.slice(0, 6).map((command) => `/${command.name}`).join('  ')
      + (matches.length > 6 ? ` +${matches.length - 6}` : ''), textWidth);
    lines.push(row('complete', <Text color={theme.muted}>{list}</Text>, list.length));
  }

  if (composer.queued !== undefined) {
    const queued = `queued ${glyphs.dot} ${clip(composer.queued, Math.max(10, textWidth - 10))}`;
    lines.push(row('queued', <Text color={theme.warn}>{queued}</Text>, queued.length));
  }

  // The settings row. The mode leads in its own colour because it is the one
  // setting that changes what the task does; the model follows in the body
  // colour; how freely the agent may act sits at the right edge, quiet at the
  // safe default and in the colour of risk when it is not. A narrow window
  // keeps the mode and the approvals and drops the model whole.
  const right = permission !== undefined ? `approvals ${permission.label}` : '';
  const narrow = band === 'narrow';
  const left = joinMeta([mode, narrow ? undefined : model], glyphs.dot);
  const room = Math.max(4, settingsWidth - right.length - 2);
  const shown = clip(left, room);
  const modeShown = shown.slice(0, Math.min(shown.length, mode.length));
  const rest = shown.slice(modeShown.length);
  const fits = right !== '' && settingsWidth - shown.length - right.length >= 1;
  const gap = Math.max(1, settingsWidth - shown.length - right.length);
  lines.push(row('settings', <>
    <Text color={modeColor(mode, theme)} bold>{modeShown}</Text>
    <Text color={theme.muted}>{rest}</Text>
    {fits
      ? <><Text>{' '.repeat(gap)}</Text><Text color={permission?.color ?? theme.muted}>{right}</Text></>
      : null}
  </>, shown.length + (fits ? gap + right.length : 0)));

  return <Box flexDirection="column" marginTop={1}>{lines}</Box>;
}
