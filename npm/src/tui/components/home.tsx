/**
 * The home screen: what a session shows before anything has been asked.
 *
 * Set the way OpenCode and Kilo set theirs — the mark, the command surface and
 * one tip as a single group, centred in the window both ways — rather than a
 * header in the top corner and a prompt on the floor with nothing between
 * them. It lives in the live region, not in `<Static>`, because a centred
 * group has to move when the window does; the masthead is printed into
 * scrollback at the first task, when the conversation takes the window over
 * and the composer drops to the foot.
 *
 * The group gives up rows in a fixed order when the window is short: the tip,
 * then the mode's description, then the wordmark, then the mode dial. The
 * composer and the line naming the product never go.
 */

import React from 'react';
import { Box } from 'ink';
import { Banner, bannerRows, showsWordmark } from './banner.js';
import { Opening } from './opening.js';
import type { Glyphs, Theme } from '../theme/tokens.js';
import type { SessionState } from '../state/types.js';

/** The composer on the home screen is a box, not a window-wide bar. */
export const HOME_COMPOSER_MAX = 72;

/** Rows under the home group that belong to the frame: status and hints. */
const FOOTER_ROWS = 2;

export interface HomePlan {
  /** Whether the wordmark is drawn. */
  readonly mark: boolean;
  /** Rows given to the mode dial and tip ({@link Opening}'s own budget). */
  readonly opening: number;
  /** Blank rows above and below the group. */
  readonly top: number;
  readonly bottom: number;
}

/**
 * Lay the group out in `rows`, one row spare: Ink redraws the live region by
 * walking back over it, and a region as tall as the window scrolls it.
 */
export function homePlan(
  rows: number, composer: number, session: SessionState, width: number, ascii: boolean,
): HomePlan {
  const budget = Math.max(0, Math.floor(rows) - 1 - FOOTER_ROWS);
  const header = bannerRows(session, 0, true); // the product line, and the last session if any
  const fixed = header + 1 + Math.max(1, composer); // header, the composer's own top margin, composer
  let mark = showsWordmark(width, ascii);
  // Rows under the composer: 5 = gap, dial, description, gap, tip;
  // 3 = gap, dial, description; 2 = gap, dial; 0 = nothing.
  const markRows = (): number => (mark ? 4 : 0);
  let opening = 5;
  const used = (): number => fixed + markRows() + opening;
  if (used() > budget) opening = 3; // drop the tip and its gap
  if (used() > budget) mark = false;
  if (used() > budget) opening = 2; // drop the description
  if (used() > budget) opening = 0; // drop the dial
  const free = Math.max(0, budget - used());
  // Centred, any odd row going below.
  const top = Math.floor(free / 2);
  return { mark, opening, top, bottom: free - top };
}

export function Home({
  session, plan, width, composerWidth, theme, glyphs, now, composer,
}: {
  session: SessionState;
  plan: HomePlan;
  /** The frame's width, which the group is centred in. */
  width: number;
  /** The composer's own width, which the group's rows are clipped to. */
  composerWidth: number;
  theme: Theme; glyphs: Glyphs; now: number;
  /** The composer, drawn by the app so input handling stays in one place. */
  composer: React.ReactNode;
}): React.ReactElement {
  return <Box flexDirection="column" width={width}>
    {plan.top > 0 ? <Box height={plan.top} /> : null}
    <Box flexDirection="column" alignItems="center" width={width}>
      <Banner
        session={session}
        width={composerWidth}
        theme={theme}
        glyphs={glyphs}
        now={now}
        mark={plan.mark}
        centered
      />
      {composer}
      {plan.opening > 1
        ? <Box marginTop={1}>
            <Opening session={session} width={composerWidth} rows={plan.opening - 1} theme={theme} glyphs={glyphs} />
          </Box>
        : null}
    </Box>
    {plan.bottom > 0 ? <Box height={plan.bottom} /> : null}
  </Box>;
}
