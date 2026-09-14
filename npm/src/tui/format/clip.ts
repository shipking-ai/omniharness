/**
 * Shortening for text that has to fit one row of a terminal.
 *
 * There were three of these: sidebar.ts and toolrow.ts held identical
 * rune-safe copies, and terminalInterface.tsx had a fourth-line shortcut that
 * sliced with `String.prototype.slice`. That slices UTF-16 code units, not
 * characters, so it cut an emoji's surrogate pair in half and left a lone
 * surrogate — "model \ud83d…" — which the terminal draws as a broken glyph.
 * `.length` counts the same units, so three emoji were charged six columns of
 * width. The file even imported one of the correct copies under another name.
 */

/**
 * Shorten text to at most `width` characters, marking a cut with an ellipsis.
 *
 * Spreading the string iterates by code point, so an astral character is never
 * split. Whitespace runs collapse to a single space first: this feeds
 * single-row contexts, where an embedded newline or tab breaks the layout it is
 * rendered into.
 */
export function clip(text: string, width: number): string {
  const runes = [...text.replace(/\s+/g, ' ')];
  if (runes.length <= width) return runes.join('');
  return `${runes.slice(0, Math.max(0, width - 1)).join('')}…`;
}
