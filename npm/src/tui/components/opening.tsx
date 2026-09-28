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
 *
 * It is set as one row of choices with the current one lit, the way Crush and
 * OpenCode show an agent picker, rather than as a four-row table: a table this
 * close to the composer read as part of the transcript. Under it, one tip, the
 * device OpenCode and Kilo use to make a first screen feel inhabited. Every tip
 * names a command that exists, from the same registry the palette reads.
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

/** Column the choices start in, after the "mode" label. */
const LABEL = 6;

/** The modes, in the order the registry declares them, with their one-liners. */
export function modeLines(): readonly { mode: AgentMode; hint: string }[] {
  return COMMANDS
    .filter((command) => command.id.startsWith('mode.'))
    .map((command) => ({
      mode: command.id.slice('mode.'.length) as AgentMode,
      hint: command.hint ?? '',
    }));
}

/**
 * One line each, and each names something that exists. The set is small on
 * purpose: a tip rotation is only pleasant while it is short enough that every
 * tip is worth reading, and each one here is a key or command the rest of the
 * screen never mentions.
 */
export function tips(): readonly string[] {
  const named = (name: string): boolean => COMMANDS.some((command) => command.name === name);
  return [
    named('resume') ? '/resume <name> picks up a saved conversation' : undefined,
    named('attach') ? '/attach <files> adds files to the next task' : undefined,
    named('find') ? '/find <text> searches everything said in this session' : undefined,
    `${KEY_LABEL.palette} lists every command, with its key`,
    'Shift+Tab changes how much the agent may do without asking',
  ].filter((tip): tip is string => tip !== undefined);
}

/** The same tip for the same workspace, so a screen does not change on reload. */
export function tipFor(workspace: string): string {
  const all = tips();
  let hash = 0;
  for (const char of workspace) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return all[hash % all.length] ?? '';
}

/** Rows {@link Opening} draws, so the height plan can place the gap under it. */
export function openingRows(_session: SessionState): number {
  // The row of modes, its description, a breathing row, the tip.
  return 4;
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
  // the tip goes first, then its breathing row, then the description; the row
  // of modes is the last thing to leave.
  const budget = Math.max(0, Math.floor(rows));
  if (budget < 1) return null;
  const all = modeLines();
  const current = all.find(({ mode }) => mode === session.mode);
  const color = modeColor(session.mode, theme);
  const tip = tipFor(session.workspace);
  const label = 'mode';
  // The key hint is the first thing to go when the row is tight, and the row
  // is truncated rather than wrapped past that: a wrapped dial is a fifth row
  // the height plan did not reserve, which is how Ink's redraw tears.
  const choices = all.reduce((sum, { mode }, index) => sum + (index > 0 ? 2 : 0) + 1 + mode.length, 0);
  const key = `   ${KEY_LABEL.cycleMode}`;
  const showKey = LABEL + choices + key.length <= width;

  return <Box flexDirection="column">
    <Text wrap="truncate-end">
      <Text color={theme.muted}>{label.padEnd(LABEL)}</Text>
      {all.map(({ mode }, index) => {
        const on = mode === session.mode;
        return <Text key={mode}>
          {index > 0 ? <Text color={theme.muted}>{'  '}</Text> : null}
          <Text color={on ? modeColor(mode, theme) : theme.muted} bold={on}>
            {on ? `${glyphs.spine}` : ' '}{mode}
          </Text>
        </Text>;
      })}
      {showKey ? <Text color={theme.muted} dimColor>{key}</Text> : null}
    </Text>
    {budget >= 2 && current !== undefined
      ? <Text color={theme.muted}>{' '.repeat(LABEL)}{clip(current.hint, Math.max(8, width - LABEL))}</Text>
      : null}
    {budget >= 4 && tip !== ''
      ? <Box marginTop={1}>
          <Text>
            <Text color={color}>{glyphs.running} </Text>
            <Text color={theme.muted} bold>Tip</Text>
            <Text color={theme.muted}>{'  '}{clip(tip, Math.max(8, width - 7))}</Text>
          </Text>
        </Box>
      : null}
  </Box>;
}
