/**
 * The opening lines of the session.
 *
 * Printed once, into scrollback, and then scrolled away like any other output.
 * That is the whole design: a permanent home screen occupying the top of the
 * window is a panel you stop reading after the first minute and pay for on
 * every redraw for the rest of the session.
 *
 * Everything on it is read from the running session. There is no tagline, no
 * banner art and no "what's new" — a start screen that states things which are
 * not true about this workspace is worse than a plain one.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { shortPath, since } from '../format/units.js';
import { clip } from '../format/clip.js';

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

/**
 * Rows the masthead prints. The height plan needs this to know how much of the
 * window is already spoken for when it sizes the opening state's gap.
 */
export function bannerRows(session: SessionState): number {
  return session.saved.length > 0 ? 3 : 2;
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

  return <Box flexDirection="column">
    <Text>
      <Text bold>OMNIHARNESS</Text>
      <Text color={theme.muted}>  {session.version}</Text>
    </Text>
    <Text color={theme.muted}>{clip(shortPath(session.workspace, width), width)}</Text>
    {recent !== undefined
      ? <Text color={theme.muted}>
          {clip(`last session ${glyphs.dot} ${recent.name} ${glyphs.dot} ${since(recent.savedAt, now)} ${glyphs.dot} /resume ${recent.name}`, width)}
        </Text>
      : null}
  </Box>;
}
