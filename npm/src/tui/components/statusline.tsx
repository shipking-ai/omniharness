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
import { phaseLabel, routeSummary, runElapsed, contextUse, unseenOutput } from '../state/selectors.js';
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

/**
 * What the work is going through. Before the gateway has decided anything, the
 * honest answer is the router itself — it is what the request is addressed to.
 * Once a decision comes back, the provider it actually chose replaces it.
 */
export function routeIdentity(state: AppState): string {
  const resolved = routeSummary(state);
  return resolved === undefined ? 'via OmniRoute' : `via ${resolved}`;
}

export function StatusLine({ state, width, band, theme, glyphs, windows, now }: StatusProps): React.ReactElement {
  const busy = state.phase !== 'idle';
  const attention = state.phase === 'awaiting-approval';

  const meter = contextUse(state, windows);
  const context = meter === undefined
    ? undefined
    : `${meterBar(meter.fraction, 6, glyphs)} ${Math.round(meter.fraction * 100)}%`;
  const contextColor = meter === undefined ? theme.muted
    : meter.zone === 'danger' ? theme.error
    : meter.zone === 'warn' ? theme.warn
    : theme.muted;

  const permission = permissionTone(state, theme);

  // The mode is the instrument's label and the phase is its reading, so they
  // are set against each other rather than run together in one dim list: caps
  // and weight for the label, ordinary text for what it currently says.
  const chip = state.session.mode.toUpperCase();
  const phase = joinMeta([phaseLabel(state), runElapsed(state, now)], glyphs.dot);
  const leftWidth = chip.length + 2 + phase.length + (busy ? 2 : 0);

  // Narrow keeps only what changes what the next keystroke does; the engine and
  // the route are a lens away and are dropped whole rather than truncated.
  const right = band === 'narrow'
    ? undefined
    : joinMeta([state.session.model, routeIdentity(state)], glyphs.dot);

  const room = Math.max(6, width - leftWidth - 2);
  const metaRoom = context === undefined ? room : Math.max(4, room - context.length - 3);
  // Engine, then route, then how freely it is allowed to act: the right-hand
  // group reads outward from what is answering to what it is permitted to do,
  // so an elevated permission lands at the edge in its own colour instead of
  // sitting next to the phase, where it read as part of the phase.
  const permissionRoom = Math.max(0, metaRoom - (right?.length ?? 0) - 3);
  const showPermission = permission.label !== '' && permissionRoom >= permission.label.length;

  return <Box flexDirection="row" justifyContent="space-between" width={width}>
    <Text>
      <Text color={modeColor(state.session.mode, theme)} bold>{chip}</Text>
      <Text color={attention ? theme.attention : busy ? theme.text : theme.muted}>
        {'  '}{busy ? `${attention ? glyphs.attention : glyphs.running} ` : ''}{phase}
      </Text>
    </Text>
    <Text>
      <Text color={theme.muted}>{right !== undefined ? clip(right, metaRoom) : ''}</Text>
      {showPermission
        ? <Text color={permission.color}>
            <Text color={theme.muted}>{right !== undefined ? ` ${glyphs.dot} ` : ''}</Text>{permission.label}
          </Text>
        : null}
      {context !== undefined
        ? <Text color={contextColor}>
            {right !== undefined || showPermission ? ` ${glyphs.dot} ` : ''}{context}
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
  // The quietest row on the screen, deliberately: it is the last thing anyone
  // needs and it should be nearly invisible until they go looking for it.
  return <Text color={theme.muted} dimColor>
    {packHints(hintsFor(state, focus, kitty, glyphs), width, glyphs.dot)}
  </Text>;
}
