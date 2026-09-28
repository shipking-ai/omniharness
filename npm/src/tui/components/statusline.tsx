/**
 * The status line and the hint line — the only permanently visible chrome.
 *
 * Two rows, and they answer two different questions. The status line says what
 * the harness is doing and what it is doing it with. The hint line says what
 * the keyboard will do *right now*, and changes with focus: a fixed footer of
 * every shortcut is a wall nobody reads, and it is wrong most of the time.
 *
 * At narrow widths the right-hand metadata is dropped rather than truncated. A
 * clipped model name is worse than no model name; the route lens has it.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { clip } from '../format/clip.js';
import { joinMeta } from './atoms.js';
import { shortPath, tildePath } from '../format/units.js';
import { KEY_LABEL } from '../input/keymap.js';
import { PERMISSION_LABEL } from '../runtime/controller.js';
import { phaseLabel, routeSummary, runElapsed, contextUse, unseenOutput } from '../state/selectors.js';
import type { WindowIndex } from '../format/context.js';
import type { Band } from '../layout/frame.js';
import type { Glyphs, Theme } from '../theme/tokens.js';
import type { Focus } from '../input/router.js';
import type { AppState } from '../state/types.js';
import { activeGlyphs } from '../theme/tokens.js';

export interface StatusProps {
  readonly state: AppState;
  readonly width: number;
  readonly band: Band;
  readonly theme: Theme;
  readonly glyphs: Glyphs;
  readonly windows: WindowIndex;
  readonly now: number;
}

/**
 * How hard the current permission setting is leaning on the user's behalf.
 *
 * The safe default is a word you read past; the two elevated settings are a
 * standing risk, and a session left on bypass should say so in the colour that
 * means risk everywhere else in this interface. This is the one place the
 * permission state appears, so it is never out of date and never doubled.
 */
export function permissionTone(state: AppState, theme: Theme): { label: string; color: string } {
  if (state.session.mode === 'crazy' || state.session.permission === 'bypass') {
    return { label: 'bypass', color: theme.error };
  }
  if (state.session.permission === 'acceptEdits') {
    return { label: PERMISSION_LABEL.acceptEdits, color: theme.warn };
  }
  return { label: PERMISSION_LABEL.ask, color: theme.muted };
}

export function StatusLine({ state, width, band, theme, glyphs, windows, now }: StatusProps): React.ReactElement {
  const busy = state.phase !== 'idle';
  const attention = state.phase === 'awaiting-approval';

  // Context in words, the way Gemini CLI and Pi write it, rather than a dithered
  // bar: a six-cell meter at one percent is six cells of noise, and the number
  // was already beside it. It takes the warning colours as it fills.
  const meter = contextUse(state, windows);
  const context = meter === undefined ? undefined : `context ${Math.round(meter.fraction * 100)}%`;
  const contextColor = meter === undefined ? theme.muted
    : meter.zone === 'danger' ? theme.error
    : meter.zone === 'warn' ? theme.warn
    : theme.muted;

  // What is happening now leads, on its own, in the foreground: it is the one
  // thing on this row anybody reads while a turn is in flight.
  const phase = joinMeta([phaseLabel(state, now), runElapsed(state, now)], glyphs.dot);
  const leftWidth = phase.length + (busy ? 2 : 0);

  // Where, and through what. The mode, model and approval setting are the
  // settings of the next task and live in the composer now; this row is the
  // session's surroundings. The route is named only once the gateway has
  // actually chosen a provider — before that, "via OmniRoute" described the
  // plumbing, not anything the user could act on. Narrow keeps only the context.
  const resolved = routeSummary(state);
  const right = band === 'narrow'
    ? undefined
    : joinMeta([
        tildePath(state.session.workspace),
        resolved === undefined ? undefined : `via ${resolved}`,
      ], glyphs.dot);

  const room = Math.max(6, width - leftWidth - 2);
  const metaRoom = context === undefined ? room : Math.max(4, room - context.length - 3);

  return <Box flexDirection="row" justifyContent="space-between" width={width}>
    <Text color={attention ? theme.attention : busy ? theme.text : theme.muted} bold={attention}>
      {busy ? `${attention ? glyphs.attention : glyphs.running} ` : ''}{phase}
    </Text>
    <Text>
      <Text color={theme.muted}>{right !== undefined && right !== '' ? shortPath(right, metaRoom) : ''}</Text>
      {context !== undefined
        ? <Text color={contextColor}>
            {right !== undefined && right !== '' ? ` ${glyphs.dot} ` : ''}{context}
          </Text>
        : null}
    </Text>
  </Box>;
}

export interface HintProps {
  readonly state: AppState;
  readonly focus: Focus;
  readonly width: number;
  readonly theme: Theme;
  readonly glyphs: Glyphs;
  readonly kitty: boolean | null;
}

/**
 * The keys that matter where the user is, most useful first. The renderer drops
 * whole hints that do not fit rather than clipping one in half — "Ctrl+T tool
 * outp…" is not a hint, it is litter.
 */
export function hintsFor(
  state: AppState, focus: Focus, kitty: boolean | null, glyphs: Glyphs,
): readonly string[] {
  switch (focus) {
    case 'approval':
      return ['y allow once', 'n deny', 'a always allow', `1-${Math.max(1, state.approval?.scopes.length ?? 1)} trust scope`];
    case 'overlay':
      return state.overlay?.kind === 'palette'
        ? ['enter run', 'esc close', `${glyphs.updown} move`, 'type to filter']
        : ['enter select', 'esc close', `${glyphs.updown} move`];
    case 'lens':
      return [
        `${glyphs.updown} move`,
        state.lens === 'sessions' ? 'enter resume' : 'enter focus',
        'esc back to run',
        `${KEY_LABEL.palette} commands`,
      ];
    case 'composer':
      // Two hints, and they are the two that lead to every other one. The rest
      // of the keymap used to sit here permanently — a footer of five shortcuts
      // that is documentation, not an interface, and that is wrong about four
      // of them most of the time. Anything else appears only in the moment it
      // can actually be used.
      return [
        state.phase !== 'idle' ? `${KEY_LABEL.interrupt} cancel` : undefined,
        `${KEY_LABEL.palette} commands`,
        `${KEY_LABEL.cycleLens} views`,
        // Offered while there is something to reveal, and not before.
        unseenOutput(state) ? `${KEY_LABEL.expandTool} output` : undefined,
        // A second line is only worth mentioning once there is a first one, and
        // which key does it depends on what the terminal answered.
        state.composer.value !== ''
          ? (kitty === true ? 'shift+enter newline' : `${KEY_LABEL.newline} newline`)
          : undefined,
      ].filter((hint): hint is string => hint !== undefined);
  }
}

/** As many whole hints as fit, in order. Never a half one. */
export function packHints(hints: readonly string[], width: number, dot = activeGlyphs().dot): string {
  const separator = `  ${dot}  `;
  const out: string[] = [];
  let used = 0;
  for (const hint of hints) {
    const cost = used === 0 ? hint.length : separator.length + hint.length;
    if (used + cost > width) break;
    out.push(hint);
    used += cost;
  }
  // Something is better than an empty row: the first hint is the important one,
  // so on a terminal too narrow for even that, clip just it.
  if (out.length === 0 && hints.length > 0) return clip(hints[0] as string, width);
  return out.join(separator);
}

export function HintLine({ state, focus, width, theme, glyphs, kitty }: HintProps): React.ReactElement {
  // The quietest row on the screen, deliberately: it is the last thing anyone
  // needs and it should be nearly invisible until they go looking for it.
  return <Text color={theme.muted} dimColor>
    {packHints(hintsFor(state, focus, kitty, glyphs), width, glyphs.dot)}
  </Text>;
}
