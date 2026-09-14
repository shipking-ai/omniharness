/**
 * Where the interface puts things at a given terminal size.
 *
 * Two separate problems, both solved here so no component has to guess:
 *
 *  Width — three bands, not one design squeezed. Narrow drops secondary
 *  metadata entirely rather than truncating it to noise; wide gets a second
 *  column beside the reading column rather than a longer line. The margin is
 *  constant so that nothing already in scrollback can fall out of alignment
 *  with what is drawn after it.
 *
 *  Height — Ink redraws its live region by walking the cursor up over the rows
 *  it wrote last time. That accounting only holds while the frame fits on
 *  screen: once it is taller than the viewport the terminal scrolls it, the
 *  cursor lands somewhere else, and the redraw eats the transcript above.
 *  So every section that can grow gets a budget rather than a fixed cap.
 */

export type Band = 'narrow' | 'normal' | 'wide';

/** Below this only the task and the composer survive. */
export const NARROW_MAX = 71;
/** At and above this the status line and hint line show their full detail. */
export const WIDE_MIN = 120;

export function band(columns: number): Band {
  if (columns <= NARROW_MAX) return 'narrow';
  return columns >= WIDE_MIN ? 'wide' : 'normal';
}

/**
 * The widest the reading column is allowed to get. Past roughly this the eye
 * loses the start of a line on the way back from the end of it.
 */
export const MAX_MEASURE = 96;
/** Constant side margin. See {@link measure} for why it is constant. */
export const GUTTER = 2;
/** Width of the secondary column on a terminal wide enough to hold one. */
export const RAIL_WIDTH = 32;
const GAP = 2;

export interface Measure {
  readonly band: Band;
  /** Left margin. Constant for a given terminal width. */
  readonly gutter: number;
  /** Columns available to the primary (reading) column. */
  readonly content: number;
  /** Columns available to the secondary column, 0 when there is none. */
  readonly rail: number;
}

/**
 * Split the terminal into a reading column and, when there is room beside it, a
 * rail.
 *
 * Two rules, both learned from watching the thing run:
 *
 *  1. **Left-aligned, constant margin.** Centring made the margin a function of
 *     how wide the frame happened to be, and the frame changes when the rail
 *     appears — so the transcript already written into scrollback kept the old
 *     margin while everything after it shifted, and a 170-column window jumped
 *     seventeen columns mid-run. A terminal is left-aligned; centring one is a
 *     web instinct that costs stability and buys nothing.
 *  2. **The rail is never taken out of the reading column.** It appears only
 *     when the terminal can hold the full measure *and* a rail beside it, so
 *     the text column is the same width whether or not there is a rail — which
 *     is what stops content re-wrapping the moment a plan arrives.
 */
export function measure(columns: number, railWanted: boolean): Measure {
  const cols = Math.max(20, Math.floor(columns));
  const gutter = cols > GUTTER * 2 + 16 ? GUTTER : 0;
  const usable = Math.max(16, cols - gutter * 2);
  const content = Math.min(MAX_MEASURE, usable);
  const rail = railWanted && usable - content - GAP >= RAIL_WIDTH ? RAIL_WIDTH : 0;
  return { band: band(cols), gutter, content, rail };
}

/** The narrowest terminal that can hold the full measure and a rail beside it. */
export const RAIL_MIN_COLUMNS = GUTTER * 2 + MAX_MEASURE + GAP + RAIL_WIDTH;

export interface HeightInput {
  readonly rows: number;
  /** Rows the composer currently occupies. */
  readonly composerLines: number;
  /** Whether an approval banner is on screen. */
  readonly approval: boolean;
  /** Whether an overlay (palette, model picker) is open. */
  readonly overlay: boolean;
  /** Rows the lens body would like, if given the room. */
  readonly lensWanted: number;
}

export interface HeightPlan {
  /** Rows the lens body may use. */
  readonly lens: number;
  /** Rows the streaming region may use; never below STREAM_FLOOR. */
  readonly stream: number;
  /** Rows the overlay list may use. */
  readonly overlay: number;
}

/** Chrome that is always drawn: composer rule, status line, hint line. */
const CHROME_ROWS = 4;
/** Rows an approval banner occupies. */
const APPROVAL_ROWS = 5;
/** Streaming never drops below this, or a running turn looks like a hang. */
export const STREAM_FLOOR = 2;

/**
 * Decide what fits. Order of sacrifice, least useful first: the lens body
 * yields to the streaming floor, and an open overlay takes what the lens would
 * have had, because an overlay is what the user is looking at.
 */
export function plan(input: HeightInput): HeightPlan {
  const rows = Math.max(8, Math.floor(input.rows));
  const composer = Math.max(1, Math.floor(input.composerLines));
  const free = Math.max(0, rows - CHROME_ROWS - composer - (input.approval ? APPROVAL_ROWS : 0));

  if (input.overlay) {
    // An overlay is modal: it gets the body, and streaming keeps only its floor
    // so a run in flight still shows it is alive behind the list.
    return { lens: 0, stream: Math.min(STREAM_FLOOR, free), overlay: Math.max(1, free - STREAM_FLOOR) };
  }

  const budget = Math.max(0, free - STREAM_FLOOR);
  const lens = Math.max(0, Math.min(Math.floor(input.lensWanted), budget));
  return { lens, stream: STREAM_FLOOR + Math.max(0, budget - lens), overlay: 0 };
}
