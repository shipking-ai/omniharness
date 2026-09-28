/**
 * The product wordmark: OMNIHARNESS in a three-row block face.
 *
 * Every terminal tool that people describe as good-looking opens with a mark
 * like this (OpenCode, Crush, Gemini CLI, Qwen Code), and every one of them
 * sets it in blocks rather than box-drawing, because half-block glyphs draw
 * solid in every monospace font while line glyphs break up at small sizes.
 *
 * Pure: the rows are strings and the colours are hex values, so both can be
 * tested at any width without a renderer.
 */

/** Each letter as three rows of equal width. */
const LETTERS: Record<string, readonly [string, string, string]> = {
  O: ['█▀▀█', '█  █', '▀▀▀▀'],
  M: ['█▀▄▀█', '█ ▀ █', '▀   ▀'],
  N: ['█▄ █', '█ ▀█', '▀  ▀'],
  I: ['▀█▀', ' █ ', '▀▀▀'],
  H: ['█  █', '█▀▀█', '▀  ▀'],
  A: ['█▀▀█', '█▀▀█', '▀  ▀'],
  R: ['█▀▀█', '█▀▀▄', '▀  ▀'],
  E: ['█▀▀▀', '█▀▀ ', '▀▀▀▀'],
  S: ['█▀▀▀', '▀▀▀█', '▀▀▀▀'],
};

export const WORD = 'OMNIHARNESS';

/** The three rows of the mark, letters one column apart. */
export function wordmarkRows(word: string = WORD): readonly [string, string, string] {
  const rows: [string[], string[], string[]] = [[], [], []];
  for (const letter of word) {
    const glyph = LETTERS[letter];
    if (glyph === undefined) throw new Error(`no wordmark glyph for ${letter}`);
    for (let row = 0; row < 3; row += 1) rows[row]!.push(glyph[row]!);
  }
  return [rows[0].join(' '), rows[1].join(' '), rows[2].join(' ')];
}

/** Columns the mark needs. */
export const WORDMARK_WIDTH = [...wordmarkRows()[0]].length;

/**
 * A colour for each column, blending `from` into `to` across the mark.
 *
 * Only for hex colours: an ANSI name has no channels to blend, and guessing a
 * ramp between "cyan" and "blue" is how a terminal theme ends up with a stripe
 * that collides with its own palette. Anything else gets one flat colour.
 */
export function gradient(from: string, to: string, columns: number): readonly string[] {
  const a = parseHex(from);
  const b = parseHex(to);
  if (a === undefined || b === undefined || columns <= 1) return Array.from({ length: Math.max(0, columns) }, () => from);
  return Array.from({ length: columns }, (_, index) => {
    const t = index / (columns - 1);
    return toHex(a.map((channel, i) => Math.round(channel + (b[i]! - channel) * t)) as [number, number, number]);
  });
}

function parseHex(value: string): [number, number, number] | undefined {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (match === null) return undefined;
  const n = Number.parseInt(match[1]!, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function toHex(rgb: [number, number, number]): string {
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}
