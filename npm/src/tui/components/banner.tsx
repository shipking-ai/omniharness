/**
 * The opening lines of the session.
 *
 * Printed once, into scrollback, and then scrolled away like any other output.
 * That is the whole design: a permanent home screen occupying the top of the
 * window is a panel you stop reading after the first minute and pay for on
 * every redraw for the rest of the session.
 *
 * Everything on it is read from the running session. There is no tagline and
 * no "what's new" — a start screen that states things which are not true about
 * this workspace is worse than a plain one.
 *
 * It does open with the wordmark. Every terminal tool people call good-looking
 * starts with one (OpenCode, Crush, Gemini CLI, Qwen Code), and the old header
 * was two lines of grey text that read as a log line, not a product. The mark
 * is printed once like the rest of this block, so it costs nothing after the
 * first screen, and it steps down to the plain header wherever it cannot draw:
 * a window narrower than the mark, or a terminal on the ASCII glyph set.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { shortPath, since, tildePath } from '../format/units.js';
import { clip } from '../format/clip.js';
import { WORDMARK_WIDTH, gradient, wordmarkRows } from '../format/wordmark.js';

import type { Glyphs, Theme } from '../theme/tokens.js';
import type { SessionState } from '../state/types.js';

export interface BannerProps {
  readonly session: SessionState;
  readonly width: number;
  readonly theme: Theme;
  readonly glyphs: Glyphs;
  readonly now: number;
}

/**
 * What `/skills` answers: everything this session can reach beyond the built-in
 * tools, including the honest answer when that is nothing.
 */
export function capabilityReport(session: SessionState): string {
  const loaded = capabilities(session);
  if (loaded === undefined) return 'no skills, plugins or MCP tools are loaded - built-in tools only';
  return `loaded: ${loaded}`;
}

/** A one-line summary of what the agent can reach beyond its built-in tools. */
export function capabilities(session: SessionState): string | undefined {
  const parts: string[] = [];
  if (session.skills > 0) {
    parts.push(`${session.skills} skill${session.skills === 1 ? '' : 's'}`
      + (session.plugins > 0 ? ` from ${session.plugins} plugin${session.plugins === 1 ? '' : 's'}` : ''));
  }
  if (session.mcpTools > 0) parts.push(`${session.mcpTools} mcp tool${session.mcpTools === 1 ? '' : 's'}`);
  return parts.length === 0 ? undefined : parts.join(' + ');
}

/** Whether the wordmark fits and can be drawn at this width with these glyphs. */
export function showsWordmark(width: number, ascii: boolean): boolean {
  return !ascii && width >= WORDMARK_WIDTH;
}

/**
 * Rows the masthead prints. The height plan needs this to know how much of the
 * window is already spoken for when it sizes the opening state's gap.
 */
export function bannerRows(session: SessionState, width = 0, ascii = true): number {
  const mark = showsWordmark(width, ascii) ? 4 : 0;
  return mark + (session.saved.length > 0 ? 2 : 1);
}

export function Banner({ session, width, theme, glyphs, now }: BannerProps): React.ReactElement {
  const recent = session.saved[0];
  // The product, the version, and where it is operating. Nothing else.
  //
  // The mode, engine and permission are absent because the status line carries
  // them live. The skill and plugin counts are absent because they are
  // capability metadata: true, occasionally useful, and not what anybody opens
  // a terminal to find out. "60 skills from 15 plugins" was the second-largest
  // thing on an empty screen and it never changed. `/skills` has it now.

  const mark = showsWordmark(width, glyphs.ascii);
  // Teal into the input blue: the two colours this interface already uses for
  // "the product" and "your words", so the mark introduces the palette rather
  // than adding to it. A terminal without truecolor gets the accent alone.
  const ramp = mark ? gradient(theme.active, theme.accent, WORDMARK_WIDTH) : [];
  const place = shortPath(tildePath(session.workspace), Math.max(8, width - session.version.length - 16));

  return <Box flexDirection="column">
    {mark
      ? <Box flexDirection="column" marginBottom={1}>
          {wordmarkRows().map((row, index) => (
            <Text key={index}>
              {[...row].map((cell, column) => (
                <Text key={column} color={ramp[column]}>{cell}</Text>
              ))}
            </Text>
          ))}
        </Box>
      : null}
    <Text>
      <Text bold>OMNIHARNESS</Text>
      <Text color={theme.muted}>  {session.version}  {glyphs.dot}  {place}</Text>
    </Text>
    {recent !== undefined
      ? <Text color={theme.muted}>
          {clip(`last session ${glyphs.dot} ${recent.name} ${glyphs.dot} ${since(recent.savedAt, now)} ${glyphs.dot} /resume ${recent.name}`, width)}
        </Text>
      : null}
  </Box>;
}
