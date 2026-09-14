/**
 * The composer.
 *
 * A caret and the text, with one rule above it and nothing else. No frame: a
 * box around the input competes with the answer above it for the eye, and at
 * narrow widths it costs two of the columns the text needs. The caret carries
 * the state instead — it takes the mode's colour, and turns red when the last
 * run failed.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { layoutEditor } from '../input/editor.js';
import { clip } from '../format/clip.js';

import { completions } from '../commands/slash.js';
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

/** Columns the composer text itself gets, once the caret gutter is taken. */
export const composerTextWidth = (width: number): number => Math.max(12, width - 2);

export function Composer({
  composer, width, mode, phase, theme, glyphs, failed,
}: ComposerProps): React.ReactElement {
  const textWidth = composerTextWidth(width);
  const caretColor = failed ? theme.error : modeColor(mode, theme);
  const layout = layoutEditor(composer.value, composer.cursor, textWidth);
  const matches = completions(composer.value);

  // No rule above it any more. A full-width horizontal line is a divider drawn
  // out of a web habit: it cut the window in half and gave the heaviest mark on
  // the screen to a separator. The blank row above and the caret's own colour
  // are enough to say where the transcript stops and the command surface
  // starts, and they cost one row instead of two.
  return <Box flexDirection="column" marginTop={1}>
    {composer.value === ''
      ? <Text color={caretColor}>
          {glyphs.caret} <Text color={theme.muted} dimColor>
            {phase === 'idle' ? 'describe the work, or / for a command' : 'type to queue the next task'}
          </Text>
        </Text>
      : layout.lines.map((line, index) => (
          <Text key={index} color={caretColor}>
            {index === 0 ? `${glyphs.caret} ` : '  '}<Text color={theme.text}>{line}</Text>
          </Text>
        ))}

    {/* Completion is offered, never applied on its own: the list appears as
        soon as the text looks like a command, and Tab takes the first. */}
    {matches.length > 0 && composer.value.trim() !== '/'
      ? <Text color={theme.muted}>
          {'  '}{clip(matches.slice(0, 6).map((command) => `/${command.name}`).join('  '), textWidth)}
          {matches.length > 6 ? ` +${matches.length - 6}` : ''}
        </Text>
      : null}

    {composer.queued !== undefined
      ? <Text color={theme.warn}>{'  '}queued {glyphs.dot} {clip(composer.queued, Math.max(10, textWidth - 10))}</Text>
      : null}
  </Box>;
}
