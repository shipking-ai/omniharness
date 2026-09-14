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
import { meterBar, joinMeta } from './atoms.js';
import { modeColor } from './composer.js';
import { KEY_LABEL } from '../input/keymap.js';
import { PERMISSION_LABEL } from '../runtime/controller.js';
import { phaseLabel, routeSummary, runElapsed, contextUse } from '../state/selectors.js';
import type { WindowIndex } from '../format/context.js';
import type { Band } from '../layout/frame.js';
import type { Glyphs, Theme } from '../theme/tokens.js';
import type { Focus } from '../input/router.js';
import type { AppState } from '../state/types.js';

export interface StatusProps {
  readonly state: AppState;
  readonly width: number;
  readonly band: Band;
  readonly theme: Theme;
  readonly glyphs: Glyphs;
  readonly windows: WindowIndex;
  readonly now: number;
}

export function StatusLine({ state, width, band, theme, glyphs, windows, now }: StatusProps): React.ReactElement {
  const busy = state.phase !== 'idle';
  const left = joinMeta([phaseLabel(state), runElapsed(state, now)], glyphs.dot);

  const meter = contextUse(state, windows);
  const context = meter === undefined
    ? undefined
    : `${meterBar(meter.fraction, 6, glyphs)} ${Math.round(meter.fraction * 100)}%`;
  const contextColor = meter === undefined ? theme.muted
    : meter.zone === 'danger' ? theme.error
    : meter.zone === 'warn' ? theme.warn
    : theme.muted;

  const permission = state.session.mode === 'crazy' ? 'bypass' : PERMISSION_LABEL[state.session.permission];
  const route = routeSummary(state);

  // Narrow keeps only what changes what the next keystroke does.
  const right = band === 'narrow'
    ? joinMeta([state.session.mode, permission], glyphs.dot)
    : joinMeta([
        state.session.mode,
        permission,
        state.session.model,
        route !== undefined ? `via ${route}` : undefined,
      ], glyphs.dot);

  const room = Math.max(8, width - left.length - 1);

  return <Box flexDirection="row" justifyContent="space-between" width={width}>
    <Text color={busy ? modeColor(state.session.mode, theme) : theme.muted}>
      {busy ? `${glyphs.running} ` : ''}{left}
    </Text>
    <Text color={theme.muted}>
      {clip(right, context === undefined ? room : Math.max(4, room - context.length - 3))}
      {context !== undefined ? <Text color={contextColor}> {glyphs.dot} {context}</Text> : null}
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
      return ['y allow once', 'n deny', 'a always allow', `1–${Math.max(1, state.approval?.scopes.length ?? 1)} trust scope`];
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
      // The palette comes second, ahead of the newline key: it is the one hint
      // that leads to every other, so it has to survive a narrow terminal.
      return [
        state.phase === 'idle' ? 'enter send' : `${KEY_LABEL.interrupt} cancel`,
        `${KEY_LABEL.palette} commands`,
        kitty === true ? 'shift+enter newline' : `${KEY_LABEL.newline} newline`,
        `${KEY_LABEL.cycleLens} views`,
        `${KEY_LABEL.expandTool} show output`,
      ];
  }
}

/** As many whole hints as fit, in order. Never a half one. */
export function packHints(hints: readonly string[], width: number, dot = '·'): string {
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
  return <Text color={theme.muted}>
    {packHints(hintsFor(state, focus, kitty, glyphs), width, glyphs.dot)}
  </Text>;
}
