/**
 * What an untouched session shows, and only an untouched session.
 *
 * The window used to open with a masthead, a composer and twenty blank rows
 * under them — not restful, just unfinished, like a program that had failed to
 * draw the rest of itself. The fix is not to fill the space with panels: it is
 * to give the opening state something worth reading and then put the command
 * surface at the foot of the window, where a command surface belongs.
 *
 * What is worth reading is the one control that changes what the harness will
 * do with the task about to be typed. Mode is the orchestration dial — whether
 * a task is mapped, built, answered, or fanned out across parallel workers —
 * and nothing else on screen says that it exists. It is shown once, it vanishes
 * the moment there is a conversation, and it never comes back.
 *
 * Everything on it is read from the running session and the same command table
 * the palette uses; there is no second copy of the mode list to drift.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { clip } from '../format/clip.js';
import { COMMANDS } from '../commands/registry.js';
import { KEY_LABEL } from '../input/keymap.js';
import { modeColor } from './composer.js';
import type { Glyphs, Theme } from '../theme/tokens.js';
import type { AgentMode } from '../../types/index.js';
import type { SessionState } from '../state/types.js';

/** Column the descriptions start in. Wide enough for the longest mode name. */
const NAME_WIDTH = 10;

/** The modes, in the order the registry declares them, with their one-liners. */
export function modeLines(): readonly { mode: AgentMode; hint: string }[] {
  return COMMANDS
    .filter((command) => command.id.startsWith('mode.'))
    .map((command) => ({
      mode: command.id.slice('mode.'.length) as AgentMode,
      hint: command.hint ?? '',
    }));
}

/** Rows {@link Opening} draws, so the height plan can place the gap under it. */
export function openingRows(_session: SessionState): number {
  // A leading gap, the heading, a breathing row under it, one row per mode.
  return modeLines().length + 3;
}

export function Opening({
  session, width, rows, theme, glyphs,
}: {
  session: SessionState;
  /** Reading measure. */
  width: number;
  rows: number; theme: Theme; glyphs: Glyphs;
}): React.ReactElement | null {
  // Budgeted like every other section, because a short window is a real window:
  // at eight rows the full panel made the live region taller than the viewport,
  // which is the one thing that corrupts Ink's redraw. The rhythm rows go
  // first, then the heading, then the list shortens, then it is gone.
  const all = modeLines();
  const budget = Math.max(0, Math.floor(rows));
  if (budget < 2) return null;
  const lead = budget >= all.length + 2 ? 1 : 0;
  const heading = budget - lead > all.length;
  const breathe = budget - lead - (heading ? 1 : 0) > all.length;
  const modes = all.slice(0, budget - lead - (heading ? 1 : 0) - (breathe ? 1 : 0));
  if (modes.length === 0) return null;

  return <Box flexDirection="column" marginTop={lead}>
    {/* The key sits beside the label it belongs to rather than against the far
        margin. Pushed to the edge it was stranded sixty columns from the word
        it explains, with nothing in between — alignment for its own sake. */}
    {heading
      ? <Text>
          <Text color={theme.muted} bold>MODE</Text>
          <Text color={theme.muted} dimColor>{'   '}{KEY_LABEL.cycleMode} cycles</Text>
        </Text>
      : null}
    {breathe ? <Box height={1} /> : null}
    {modes.map(({ mode, hint }) => {
      const current = mode === session.mode;
      // The mode in force is marked with the composer's own spine, in the
      // composer's own colour, in the same column. Two marks, one meaning: this
      // is the mode, and that is the prompt it runs. It makes the selection
      // unmistakable without a border, a box, or a second colour — and it is
      // the one thing on the opening screen that ties the dial to the surface
      // underneath it.
      return <Text key={mode}>
        <Text color={current ? modeColor(mode, theme) : theme.muted} bold={current}>
          {current ? `${glyphs.spine} ` : '  '}
        </Text>
        <Text color={current ? modeColor(mode, theme) : theme.muted} bold={current}>
          {mode.padEnd(NAME_WIDTH)}
        </Text>
        {/* Three levels down the column, and none of them is a box: the mode in
            force is bright, the rest are muted, the descriptions dimmer still. */}
        <Text color={current ? theme.text : theme.muted} dimColor={!current}>
          {clip(hint, Math.max(8, width - NAME_WIDTH - 2))}
        </Text>
      </Text>;
    })}
  </Box>;
}
