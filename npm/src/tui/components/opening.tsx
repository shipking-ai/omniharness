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
export function openingRows(session: SessionState): number {
  return modeLines().length + (session.saved.length > 0 ? 3 : 2);
}

export function Opening({
  session, width, rows, theme, glyphs,
}: {
  session: SessionState; width: number; rows: number; theme: Theme; glyphs: Glyphs;
}): React.ReactElement | null {
  const saved = session.saved.length;
  // Budgeted like every other section, because a short window is a real window:
  // at eight rows the full panel made the live region taller than the viewport,
  // which is the one thing that corrupts Ink's redraw. The leading gap and the
  // footnote go first, then the list shortens, then it is gone.
  const budget = Math.max(0, Math.floor(rows));
  if (budget < 2) return null;
  const gap = budget >= modeLines().length + 2 ? 1 : 0;
  const footnote = budget - gap > modeLines().length;
  const modes = modeLines().slice(0, budget - gap - (footnote ? 1 : 0));
  if (modes.length === 0) return null;

  return <Box flexDirection="column" marginTop={gap}>
    {modes.map(({ mode, hint }) => {
      const current = mode === session.mode;
      return <Text key={mode}>
        {/* The marker column is the same two cells every status row in this
            interface uses, so the list hangs off the same edge as everything
            above and below it. */}
        <Text color={current ? modeColor(mode, theme) : theme.muted}>
          {current ? `${glyphs.caret} ` : '  '}
        </Text>
        <Text color={current ? modeColor(mode, theme) : theme.muted} bold={current}>
          {mode.padEnd(NAME_WIDTH)}
        </Text>
        <Text color={theme.muted} dimColor={!current}>
          {clip(hint, Math.max(8, width - NAME_WIDTH - 2))}
        </Text>
      </Text>;
    })}
    {footnote
      ? <Text color={theme.muted} dimColor>
          {'  '}{clip(
            `${KEY_LABEL.cycleMode} cycles ${glyphs.dot} /mode <name> sets`
            + (saved > 0 ? `  ${glyphs.dot}  ${saved} saved session${saved === 1 ? '' : 's'} ${glyphs.dot} /resume` : ''),
            Math.max(8, width - 2),
          )}
        </Text>
      : null}
  </Box>;
}
