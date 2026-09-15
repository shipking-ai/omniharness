/**
 * Design tokens for the interface.
 *
 * There are six colours and they mean six things. Colour is never decoration
 * here: if a row is coloured, the colour is the status. Anything that is not a
 * status is `text` or `muted`, and hierarchy comes from weight, spacing and
 * alignment instead.
 *
 * The palette itself (theme resolution, truecolor vs ANSI-16, NO_COLOR) lives
 * in ./palette.ts and is unchanged; this maps its roles onto the interface's
 * vocabulary so views never reach for a raw colour name.
 */

import { palette, type Palette } from './palette.js';

export interface Theme {
  /** Ordinary body text. `undefined` means "the terminal's own foreground". */
  readonly text: undefined;
  /** Secondary text: labels, metadata, anything you read second. */
  readonly muted: string;
  /** The product accent: the user's own words, focus, selection. */
  readonly accent: string;
  /** In flight. */
  readonly active: string;
  readonly success: string;
  readonly warn: string;
  readonly error: string;
  /** Something is waiting on a human. */
  readonly attention: string;
  /**
   * A background for the user's own task, or undefined when the terminal
   * cannot be trusted with one. Nothing else may take a surface: the moment a
   * second element has a background, the transcript is a stack of cards.
   */
  readonly surface: string | undefined;
}

export function theme(env: Record<string, string | undefined> = process.env): Theme {
  const p: Palette = palette(env);
  return {
    text: undefined,
    muted: p.muted,
    accent: p.info,
    active: p.accent,
    success: p.success,
    warn: p.warn,
    error: p.error,
    attention: p.warn,
    surface: p.surface,
  };
}

/**
 * Whether the terminal can be trusted with box-drawing and geometric glyphs.
 *
 * A terminal on a non-UTF-8 locale draws `●` as two mojibake bytes, and the
 * status column stops lining up. `OMNIHARNESS_ASCII` forces the plain set for
 * anyone whose font is the problem rather than their locale.
 */
export function unicodeSafe(env: Record<string, string | undefined> = process.env): boolean {
  if (env.OMNIHARNESS_ASCII !== undefined && env.OMNIHARNESS_ASCII !== '' && env.OMNIHARNESS_ASCII !== '0') return false;
  const locale = env.LC_ALL ?? env.LC_CTYPE ?? env.LANG;
  if (locale === undefined) return process.platform === 'win32';
  return /utf-?8/i.test(locale);
}

export interface Glyphs {
  /** True when this is the plain set, for the few places Ink needs to know. */
  readonly ascii: boolean;
  readonly running: string;
  readonly done: string;
  readonly pending: string;
  readonly waiting: string;
  readonly failed: string;
  readonly denied: string;
  /** Reserved for the approval gate — nothing else may use it. */
  readonly attention: string;
  /** Left rule beside expanded output. */
  readonly rule: string;
  /**
   * The command surface's own mark. The composer draws it as Ink's left border
   * down its whole height; the mode in force on the opening screen draws it as
   * a single cell in the same column, so the two read as one device.
   */
  readonly spine: string;
  /** Horizontal rule above the composer. */
  readonly hrule: string;
  /** Vertical-movement hint, spelled out when arrows will not draw. */
  readonly updown: string;
  /** Separator between inline metadata. */
  readonly dot: string;
  /**
   * Punctuation that is not decoration but still is not ASCII. Every one of
   * these was hardcoded in a rendered string somewhere, which meant the plain
   * set did not actually reach the screen: a terminal that cannot draw them got
   * mojibake rather than the fallback it had asked for.
   */
  readonly dash: string;
  readonly ellipsis: string;
  readonly arrow: string;
  readonly caret: string;
  readonly cursor: string;
  readonly selected: string;
  readonly meterFull: string;
  readonly meterEmpty: string;
}

const UNICODE: Glyphs = {
  ascii: false,
  running: '●',
  done: '✓',
  pending: '○',
  waiting: '◌',
  failed: '✗',
  denied: '⊘',
  attention: '▲',
  rule: '│',
  spine: '┃',
  hrule: '─',
  updown: '↑↓',
  dot: '·',
  dash: '—',
  ellipsis: '…',
  arrow: '→',
  caret: '›',
  cursor: '▍',
  selected: '›',
  meterFull: '█',
  meterEmpty: '░',
};

const ASCII: Glyphs = {
  ascii: true,
  running: '*',
  done: '+',
  pending: '-',
  waiting: '.',
  failed: 'x',
  denied: '~',
  attention: '!',
  rule: '|',
  spine: '|',
  hrule: '-',
  updown: 'up/down',
  dot: '-',
  dash: '-',
  ellipsis: '...',
  arrow: '->',
  caret: '>',
  cursor: '_',
  selected: '>',
  meterFull: '#',
  meterEmpty: '.',
};

export function glyphs(env: Record<string, string | undefined> = process.env): Glyphs {
  return unicodeSafe(env) ? UNICODE : ASCII;
}

/**
 * The resolved set, for the few leaf utilities that render a glyph but are not
 * given one: truncation markers, the context meter, the editor caret. They are
 * pure functions of their arguments plus the environment, and re-resolving is a
 * couple of string comparisons, so the answer is cached against the variables
 * that decide it rather than computed once at import — a test that sets
 * `OMNIHARNESS_ASCII` after the module loads still gets the plain set.
 */
let cached: { key: string; glyphs: Glyphs } | undefined;
export function activeGlyphs(env: Record<string, string | undefined> = process.env): Glyphs {
  const key = `${env.OMNIHARNESS_ASCII ?? ''}\u0000${env.LC_ALL ?? ''}\u0000${env.LC_CTYPE ?? ''}\u0000${env.LANG ?? ''}`;
  if (cached?.key !== key) cached = { key, glyphs: glyphs(env) };
  return cached.glyphs;
}
