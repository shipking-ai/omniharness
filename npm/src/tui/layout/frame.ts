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
/** Narrowest useful secondary column; below this it holds nothing legible. */
export const RAIL_WIDTH = 32;
/** Widest it is allowed to grow into on a very wide terminal. */
export const RAIL_MAX = 44;
const GAP = 2;

export interface Measure {
  readonly band: Band;
  /** Left margin. Constant for a given terminal width. */
  readonly gutter: number;
  /** Columns available to the primary (reading) column. */
  readonly content: number;
  /** Columns available to the secondary column, 0 when there is none. */
  readonly rail: number;
  /**
   * Columns between the reading column and the rail. Not a constant: the rail
   * is set flush against the right margin, so the gap absorbs whatever the
   * window has spare. A rail floating in the middle of a 200-column window with
   * forty empty columns beyond it is the "same UI, but wider" failure.
   */
  readonly railGap: number;
  /**
   * Columns the bottom instrument row spans: everything between the margins.
   *
   * Prose stops at {@link MAX_MEASURE} because a 200-column line is unreadable,
   * but the status row is not prose — it is an instrument, read by position
   * rather than left to right. Letting it span the window is what stops a wide
   * terminal from being the same interface with more void to its right, and it
   * costs nothing, because the reading column is unchanged underneath it.
   */
  readonly chrome: number;
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
  // Everything is laid out inside a bounded frame rather than against the
  // window edge. Past this width there is nothing left to put in the extra
  // columns, and spending them anyway is how a 220-column window ends up with
  // a status line whose two halves are a hundred columns apart — stretched,
  // not designed. Beyond the frame the window is simply margin.
  const frame = Math.min(usable, MAX_MEASURE + GAP + RAIL_MAX);
  const spare = frame - content - GAP;
  const rail = railWanted && spare >= RAIL_WIDTH ? Math.min(RAIL_MAX, spare) : 0;
  // The frame does not depend on whether a rail is drawn, so the instrument row
  // keeps its width when a plan arrives. Sizing it to the columns currently in
  // use made it change width mid-run — one row, but the one always on screen.
  return { band: band(cols), gutter, content, rail, railGap: frame - content - rail, chrome: frame };
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
  /**
   * Rows already printed above the live region that are still on screen — the
   * masthead, before anything has scrolled it away. Only meaningful in the
   * opening state; see {@link HeightPlan.pad}.
   */
  readonly printed?: number;
  /** Whether this is the opening state: nothing said yet, nothing running. */
  readonly opening?: boolean;
}

export interface HeightPlan {
  /** Rows the lens body may use. */
  readonly lens: number;
  /** Rows the streaming region may use; never below STREAM_FLOOR. */
  readonly stream: number;
  /** Rows the overlay list may use. */
  readonly overlay: number;
  /**
   * Blank rows between the body and the composer, so that an untouched session
   * fills the window instead of sitting in its top corner above a void.
   *
   * Only ever non-zero in the opening state, and it is computed rather than
   * grown with flex because the exact row count matters: Ink redraws its live
   * region by walking the cursor back up over the rows it wrote, and a region
   * one row taller than the viewport makes the terminal scroll under it and the
   * next redraw eat the transcript. One row is deliberately left spare.
   */
  readonly pad: number;
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
    return { lens: 0, stream: Math.min(STREAM_FLOOR, free), overlay: Math.max(1, free - STREAM_FLOOR), pad: 0 };
  }

  const budget = Math.max(0, free - STREAM_FLOOR);
  const lens = Math.max(0, Math.min(Math.floor(input.lensWanted), budget));
  const stream = STREAM_FLOOR + Math.max(0, budget - lens);
  return { lens, stream, overlay: 0, pad: openingPad(input, rows, composer) };
}

/**
 * The blank rows that push the opening state's command surface to the foot of
 * the window.
 *
 * Everything on screen at that moment is known and fixed — the masthead, the
 * standing panel, the composer and its two chrome rows — so the gap is simple
 * arithmetic rather than a guess. Outside the opening state it is zero: once
 * there is a transcript, the content is what fills the window, and padding
 * under it would only push the conversation off the top.
 */
function openingPad(input: HeightInput, rows: number, composer: number): number {
  if (input.opening !== true) return 0;
  const used = Math.max(0, Math.floor(input.printed ?? 0))
    + Math.max(0, Math.floor(input.lensWanted))
    + composer
    + CHROME_ROWS;
  // The spare row is the safety margin against an off-by-one in what the
  // masthead actually printed: too short merely looks like the old layout,
  // while too tall corrupts the scrollback.
  return Math.max(0, rows - 1 - used);
}
