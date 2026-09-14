/**
 * Where the interface puts things at a given terminal size.
 *
 * Two separate problems, both solved here so no component has to guess:
 *
 *  Width — three bands, not one design squeezed. Narrow drops secondary
 *  metadata entirely rather than truncating it to noise; wide gets a second
 *  column rather than a longer line.
 *
 *  Height — Ink redraws its live region by walking the cursor up over the rows
 *  it wrote last time. That accounting only holds while the frame fits on
 *  screen: once it is taller than the viewport the terminal scrolls it, the
 *  cursor lands somewhere else, and the redraw eats the transcript above.
 *  So every section that can grow gets a budget rather than a fixed cap.
 */

export type Band = 'narrow' | 'normal' | 'wide';

/** Below this a second column cannot hold anything worth reading. */
export const WIDE_MIN = 120;
/** Below this only the task and the composer survive. */
export const NARROW_MAX = 71;

export function band(columns: number): Band {
  if (columns <= NARROW_MAX) return 'narrow';
  return columns >= WIDE_MIN ? 'wide' : 'normal';
}

/** Width of the secondary column on a wide terminal. */
export const RAIL_WIDTH = 32;

export interface Measure {
  readonly band: Band;
  /** Total columns the interface draws into, centred in the terminal. */
  readonly frame: number;
  /** Left/right padding that centres the frame. */
  readonly gutter: number;
  /** Columns available to the primary (reading) column. */
  readonly content: number;
  /** Columns available to the secondary column, 0 when there is none. */
  readonly rail: number;
}

/**
 * Split the terminal into a reading column and, on a wide terminal, a rail.
 * `railWanted` is false when there is nothing to put in the rail — an empty
 * column is worse than a wider one.
 */
export function measure(columns: number, railWanted: boolean): Measure {
  const cols = Math.max(20, Math.floor(columns));
  const size = band(cols);
  const rail = size === 'wide' && railWanted ? RAIL_WIDTH : 0;
  const frame = Math.min(cols, MAX_FRAME + (rail > 0 ? rail + GAP : 0));
  const gutter = Math.max(0, Math.floor((cols - frame) / 2));
  const content = Math.max(16, frame - (rail > 0 ? rail + GAP : 0));
  return { band: size, frame, gutter, content, rail };
}

const MAX_FRAME = 96;
const GAP = 2;

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
