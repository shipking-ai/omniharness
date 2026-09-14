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
import { PERMISSION_LABEL } from '../runtime/controller.js';
import type { Glyphs, Theme } from '../theme/tokens.js';
import type { SessionState } from '../state/types.js';

export interface BannerProps {
  readonly session: SessionState;
  readonly width: number;
  readonly theme: Theme;
  readonly glyphs: Glyphs;
  readonly now: number;
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

export function Banner({ session, width, theme, glyphs, now }: BannerProps): React.ReactElement {
  const loaded = capabilities(session);
  const recent = session.saved[0];
  const detail = [
    session.model,
    session.mode,
    session.mode === 'crazy' ? 'bypass' : PERMISSION_LABEL[session.permission],
    loaded,
  ].filter((part): part is string => part !== undefined).join(`  ${glyphs.dot}  `);

  return <Box flexDirection="column">
    <Text>
      <Text bold>OMNIHARNESS</Text>
      <Text color={theme.muted}> {session.version}</Text>
    </Text>
    <Text color={theme.muted}>{clip(shortPath(session.workspace, Math.max(12, width - 12)), width)}</Text>
    <Text color={theme.muted}>{clip(detail, width)}</Text>
    {recent !== undefined
      ? <Text color={theme.muted}>
          {clip(`last session ${recent.name} ${glyphs.dot} ${since(recent.savedAt, now)} ${glyphs.dot} /resume ${recent.name}`, width)}
        </Text>
      : null}
  </Box>;
}
