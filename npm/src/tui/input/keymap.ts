/**
 * The keymap: raw terminal input → one named intent.
 *
 * Keys arrive from two places and always have. Ink's `useInput` handles plain
 * text and legacy keys correctly; a raw stdin listener is needed for the ones
 * Ink 5 mislabels (kitty CSI-u sequences, Windows ConPTY's DEL-for-Backspace,
 * back-tab). Both adapters land here, so there is exactly one table of what a
 * key means — the old interface decided that in three different handlers and
 * they disagreed about Shift+Tab.
 *
 * Pure: no state, no dispatch. What an intent *does* depends on what is
 * focused, and that decision lives in ./router.ts.
 */

import { parseRawKey, isEncodedKey } from './rawkeys.js';

export type Intent =
  // editing
  | { readonly kind: 'insert'; readonly text: string }
  | { readonly kind: 'newline' }
  | { readonly kind: 'backspace' }
  | { readonly kind: 'delete' }
  | { readonly kind: 'left' }
  | { readonly kind: 'right' }
  | { readonly kind: 'home' }
  | { readonly kind: 'end' }
  | { readonly kind: 'tab' }
  // navigation and confirmation
  | { readonly kind: 'up' }
  | { readonly kind: 'down' }
  | { readonly kind: 'submit' }
  | { readonly kind: 'escape' }
  | { readonly kind: 'interrupt' }
  // commands bound to a key
  | { readonly kind: 'palette' }
  | { readonly kind: 'cycleLens' }
  | { readonly kind: 'cycleMode' }
  | { readonly kind: 'cyclePermission' }
  | { readonly kind: 'models' }
  | { readonly kind: 'expandTool' }
  | { readonly kind: 'copyReply' };

/** Ink's parsed key flags — the subset this map reads. */
export interface InkKey {
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
  readonly return: boolean;
  readonly escape: boolean;
  readonly backspace: boolean;
  readonly delete: boolean;
  readonly tab: boolean;
  readonly upArrow: boolean;
  readonly downArrow: boolean;
  readonly leftArrow: boolean;
  readonly rightArrow: boolean;
}

/**
 * Control keys, by the letter they carry. Chosen so nothing collides with a
 * readline reflex a terminal user already has, and so every binding earns its
 * place: a view is reached through the palette or a slash command, and only the
 * things done many times per session get a key of their own.
 */
const CONTROL: Readonly<Record<string, Intent>> = {
  k: { kind: 'palette' },
  l: { kind: 'cycleLens' },
  e: { kind: 'cycleMode' },
  o: { kind: 'models' },
  t: { kind: 'expandTool' },
  y: { kind: 'copyReply' },
};

/**
 * Translate Ink's own parse. Returns null for input this layer does not claim,
 * including protocol replies the terminal sends to queries the app made — those
 * arrive on the same stdin and, unrecognised, get typed into the composer.
 */
export function fromInk(value: string, key: InkKey): Intent | null {
  if (key.ctrl && value === 'c') return { kind: 'interrupt' };
  if (key.ctrl) {
    const bound = CONTROL[value.toLowerCase()];
    if (bound !== undefined) return bound;
    // Ctrl+J arrives as a bare line feed and is the only newline a terminal
    // without the kitty protocol can produce.
    if (value === '\n' || value === 'j') return { kind: 'newline' };
    return null;
  }
  // Escape is checked before `meta`, not after. Ink sets `meta` for anything
  // that arrived ESC-prefixed, and a lone Escape *is* ESC-prefixed — reading
  // meta first swallowed the one key that closes an overlay.
  if (key.escape) return { kind: 'escape' };
  if (key.meta) return null;
  // Shift+Tab reaches the raw listener as ESC[Z; claiming it here as well would
  // apply it twice.
  if (key.tab && key.shift) return null;
  if (key.tab) return { kind: 'tab' };
  if (key.return) return { kind: 'submit' };
  if (key.backspace) return { kind: 'backspace' };
  if (key.delete) return { kind: 'delete' };
  if (key.upArrow) return { kind: 'up' };
  if (key.downArrow) return { kind: 'down' };
  if (key.leftArrow) return { kind: 'left' };
  if (key.rightArrow) return { kind: 'right' };
  if (value === '\n') return { kind: 'newline' };
  if (value === '' || isEncodedKey(value)) return null;
  return { kind: 'insert', text: value };
}

/**
 * Translate a raw stdin chunk, for the sequences Ink gets wrong. Returns null
 * for everything else, so the two adapters never both claim one keystroke.
 */
export function fromRaw(chunk: string): Intent | null {
  const action = parseRawKey(chunk);
  if (action === null) return null;
  switch (action.kind) {
    case 'submit': return { kind: 'submit' };
    case 'newline': return { kind: 'newline' };
    case 'backspace': return { kind: 'backspace' };
    case 'delete': return { kind: 'delete' };
    case 'left': return { kind: 'left' };
    case 'right': return { kind: 'right' };
    case 'up': return { kind: 'up' };
    case 'down': return { kind: 'down' };
    case 'home': return { kind: 'home' };
    case 'end': return { kind: 'end' };
    case 'escape': return { kind: 'escape' };
    case 'tab': return { kind: 'tab' };
    case 'shiftTab': return { kind: 'cyclePermission' };
    case 'ctrlC': return { kind: 'interrupt' };
    case 'ctrlM': return { kind: 'cycleMode' };
    case 'ctrlO': return { kind: 'models' };
    case 'ctrlE': return { kind: 'cycleMode' };
    case 'ctrlB': return { kind: 'palette' };
  }
}

/** What each binding is called on screen. The hint line reads from this. */
export const KEY_LABEL: Readonly<Record<string, string>> = {
  palette: 'Ctrl+K',
  cycleLens: 'Ctrl+L',
  cycleMode: 'Ctrl+E',
  cyclePermission: 'Shift+Tab',
  models: 'Ctrl+O',
  expandTool: 'Ctrl+T',
  copyReply: 'Ctrl+Y',
  interrupt: 'Ctrl+C',
  newline: 'Ctrl+J',
};
