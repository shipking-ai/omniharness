/**
 * Markdown → styled segments for the terminal chat.
 *
 * Pure functions: parse the common chat markdown subset (bold, italic,
 * strikethrough, inline code, links, headings, lists, blockquotes, code
 * fences, GFM tables, rules) into lines of styled segments, word-wrapped
 * to a column width. Unclosed constructs degrade to plain text.
 */

import { highlightCode } from './highlight.js';

export interface MarkdownSegment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  dim?: boolean;
  color?: string;
  /** Keep the whole text as one unit through word-splitting (e.g. `[ ]`). */
  atomic?: boolean;
}

interface StyledWord {
  text: string;
  style: Omit<MarkdownSegment, 'text'>;
  /** Continues the previous word with no space between them. */
  glued?: boolean;
}

type Align = 'left' | 'right' | 'center';

const TOKEN_RE = /(\~\~[^~]+\~\~|\*\*[^*]+\*\*|`[^`\n]+`|\*[^*\n]+\*|\[[^\]]+\]\([^)\s]+\))/g;
const DELIM_RE = /^\s*:?-+:?\s*$/;
const BULLETS = ['•', '◦', '▪'] as const;
const ASCII_BULLETS = ['-', '*', '+'] as const;

/**
 * How to draw the few characters that are pictures rather than text. A terminal
 * on a non-UTF-8 locale renders `•` and `─` as mojibake, and a list whose
 * bullets are broken bytes is worse than one bulleted with a hyphen.
 */
export interface MarkdownStyle {
  readonly ascii?: boolean;
}
const BOX_RE = /^\[([ xX])\]\s*(.*)$/;

/** Parse inline formatting into styled segments. */
function inline(text: string): MarkdownSegment[] {
  const out: MarkdownSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN_RE)) {
    const index = match.index ?? 0;
    if (index > last) out.push({ text: text.slice(last, index) });
    const token = match[0];
    if (token.startsWith('~~')) out.push({ text: token.slice(2, -2), strikethrough: true });
    else if (token.startsWith('**')) out.push({ text: token.slice(2, -2), bold: true });
    else if (token.startsWith('`')) out.push({ text: token.slice(1, -1), color: 'cyan' });
    else if (token.startsWith('[')) {
      const close = token.indexOf('](');
      out.push({ text: token.slice(1, close), underline: true, color: 'blue' });
      out.push({ text: ` ${token.slice(close + 2, -1)}`, dim: true });
    } else {
      out.push({ text: token.slice(1, -1), italic: true });
    }
    last = index + token.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/**
 * Split segments into words, marking the pieces that must not be separated.
 *
 * A styled token and the punctuation that follows it are one word: `` `x.go` ``
 * followed by `:` arrives as two segments with no space between them, and
 * splitting each segment on its own put a space in — every inline code span,
 * link and bold run followed by a comma or a colon rendered as "x.go :".
 * `glued` says "this piece continues the previous one"; the wrapper honours it.
 */
function wordsOf(segments: readonly MarkdownSegment[]): StyledWord[] {
  const words: StyledWord[] = [];
  // True while the previous piece ended flush against a segment boundary, so
  // whatever comes next continues the same word.
  let open = false;
  for (const segment of segments) {
    const { text, atomic, ...style } = segment;
    if (text === '') continue;
    // An atomic segment is a whole word by construction — a list bullet, a
    // checkbox — and is separated from its neighbours like any other word.
    if (atomic) { words.push({ text, style }); open = false; continue; }
    const tightStart = !/^\s/.test(text);
    const pieces = text.split(' ');
    for (let i = 0; i < pieces.length; i += 1) {
      const piece = pieces[i] as string;
      if (piece === '') continue;
      words.push({ text: piece, style, glued: i === 0 && open && tightStart });
    }
    open = !/\s$/.test(text);
  }
  return words;
}

/** Greedily fill lines up to `width`, hard-breaking words that exceed it. */
function wrapWords(words: readonly StyledWord[], width: number): MarkdownSegment[][] {
  const lines: MarkdownSegment[][] = [];
  let line: MarkdownSegment[] = [];
  let lineLen = 0;
  const flush = (): void => {
    if (line.length > 0) { lines.push(line); line = []; lineLen = 0; }
  };
  for (const word of words) {
    let rest = word.text;
    while (rest.length > width) {
      if (lineLen > 0) flush();
      line.push({ text: rest.slice(0, width), ...word.style });
      rest = rest.slice(width);
      flush();
    }
    if (rest === '') continue;
    // A glued piece never takes a leading space and never starts a line on its
    // own if it can help it — it belongs to the word already on this one.
    const gap = lineLen > 0 && word.glued !== true ? 1 : 0;
    if (lineLen + gap + rest.length <= width || (word.glued === true && lineLen > 0)) {
      if (gap > 0) line.push({ text: ' ', ...word.style });
      line.push({ text: rest, ...word.style });
      lineLen += gap + rest.length;
    } else {
      flush();
      line.push({ text: rest, ...word.style });
      lineLen = rest.length;
    }
  }
  flush();
  return lines;
}

function hardSlice(text: string, width: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > width) { out.push(rest.slice(0, width)); rest = rest.slice(width); }
  out.push(rest);
  return out;
}

const plainWidth = (segments: readonly MarkdownSegment[]): number => segments.reduce((n, s) => n + s.text.length, 0);

/** Split a table row on unescaped pipes, stripping the cells created by leading/trailing pipes. */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\' && line[i + 1] === '|') { current += '|'; i += 1; }
    else if (ch === '|') { cells.push(current); current = ''; }
    else current += ch;
  }
  cells.push(current);
  const trimmed = cells.map((cell) => cell.trim());
  if (trimmed[0] === '' && line.startsWith('|')) trimmed.shift();
  if (trimmed[trimmed.length - 1] === '' && line.endsWith('|')) trimmed.pop();
  return trimmed;
}

function alignOf(cell: string): Align {
  const value = cell.trim();
  const left = value.startsWith(':');
  const right = value.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  return 'left';
}

/** Render a validated GFM table as aligned lines of styled segments. */
function renderTable(
  header: string[],
  aligns: readonly Align[],
  body: readonly (readonly string[])[],
  width: number,
  ascii: boolean,
): MarkdownSegment[][] {
  const hrule = ascii ? '-' : '─';
  const tee = ascii ? (['+', '+', '+'] as const) : (['├', '┼', '┤'] as const);
  const bar = ascii ? '|' : '│';
  const cols = header.length;
  const rows: (readonly (readonly MarkdownSegment[])[])[] = [header, ...body].map((row) =>
    Array.from({ length: cols }, (_, c) => inline(row[c] ?? '')),
  );
  const colWidths = Array.from({ length: cols }, (_, c) =>
    Math.max(3, ...rows.map((row) => plainWidth(row[c] ?? []))),
  );
  let total = colWidths.reduce((n, w) => n + w, 0) + 3 * cols + 1;
  while (total > width) {
    const widest = colWidths.indexOf(Math.max(...colWidths));
    if (colWidths[widest] <= 3) break;
    colWidths[widest] -= 1;
    total -= 1;
  }
  const out: MarkdownSegment[][] = [];
  rows.forEach((row, r) => {
    const wrapped = row.map((cell, c) => wrapWords(wordsOf(cell), colWidths[c]));
    const height = Math.max(1, ...wrapped.map((cellLines) => cellLines.length));
    for (let l = 0; l < height; l += 1) {
      const segments: MarkdownSegment[] = [];
      for (let c = 0; c < cols; c += 1) {
        const line = wrapped[c]?.[l] ?? [];
        const pad = Math.max(0, colWidths[c] - plainWidth(line));
        segments.push({ text: `${bar} ` });
        if (aligns[c] === 'right') segments.push({ text: ' '.repeat(pad) }, ...line);
        else if (aligns[c] === 'center') segments.push({ text: ' '.repeat(Math.floor(pad / 2)) }, ...line, { text: ' '.repeat(Math.ceil(pad / 2)) });
        else segments.push(...line, { text: ' '.repeat(pad) });
        segments.push({ text: ' ' });
      }
      segments.push({ text: bar });
      out.push(r === 0 ? segments.map((s) => ({ ...s, bold: true, color: s.color ?? 'cyan' })) : segments);
    }
    if (r === 0) {
      out.push([{
        text: `${tee[0]}${colWidths.map((w) => hrule.repeat(w + 2)).join(tee[1])}${tee[2]}`,
        dim: true,
      }]);
    }
  });
  return out;
}

/**
 * Render markdown text as wrapped lines of styled segments.
 * Code fences are preserved verbatim (hard-sliced to width, not word-wrapped).
 * Tables require a header row with pipes and a matching delimiter row, so a
 * stray pipe in prose is never rendered as a table.
 */
export function renderMarkdown(
  text: string, width: number, style: MarkdownStyle = {},
): MarkdownSegment[][] {
  const bullets = style.ascii === true ? ASCII_BULLETS : BULLETS;
  const rule = style.ascii === true ? '-' : '─';
  const out: MarkdownSegment[][] = [];
  const src = text.replace(/\r/g, '').split('\n');
  let i = 0;
  while (i < src.length) {
    const line = src[i];
    const fence = /^```\s*([A-Za-z0-9_+-]*)\s*$/.exec(line);
    if (fence) {
      const code: string[] = [];
      i += 1;
      while (i < src.length && !/^```/.test(src[i])) { code.push(src[i]); i += 1; }
      i += 1; // skip closing fence
      // A fenced block gets the same left rule that tool output gets: it marks
      // machine text as machine text, which indentation alone does not — a code
      // block set flush with the prose around it reads as another paragraph
      // that happens to be oddly worded.
      const rule: MarkdownSegment = { text: style.ascii === true ? '| ' : '│ ', dim: true, atomic: true };
      for (const row of highlightCode(code, fence[1] === '' ? undefined : fence[1], Math.max(8, width - 2))) {
        out.push([rule, ...row]);
      }
      continue;
    }
    if (/^\s*$/.test(line)) {
      // One blank row between blocks, never at the top and never two in a row.
      // Dropping them entirely ran every paragraph of a reply into the next,
      // which is the commonest readability problem in a transcript.
      if (out.length > 0 && out[out.length - 1]?.length !== 0) out.push([]);
      i += 1;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const segments = inline(heading[2]).map((s) => ({ ...s, bold: true, color: s.color ?? 'cyan' }));
      out.push(...wrapWords(wordsOf(segments), width));
      i += 1;
      continue;
    }
    if (/^\s*([-*_])\s*([-*_])\s*([-*_])\s*$/.test(line)) {
      out.push([{ text: rule.repeat(width), dim: true }]);
      i += 1;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quote = line.replace(/^\s*>\s?/, '');
      const segments = inline(quote).map((s) => ({ ...s, dim: true }));
      out.push(...wrapWords(wordsOf([{ text: '│ ' }, ...segments]), width));
      i += 1;
      continue;
    }
    const list = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (list) {
      const level = Math.min(Math.floor(list[1].length / 2), bullets.length - 1);
      const marker = /^\d/.test(list[2]) ? list[2] : bullets[level];
      const box = BOX_RE.exec(list[3]);
      const segments: MarkdownSegment[] = [{ text: `${'  '.repeat(level)}${marker}`, atomic: true }];
      if (box) {
        const checked = box[1] !== ' ';
        segments.push({ text: checked ? '[x]' : '[ ]', atomic: true, ...(checked ? { color: 'green' } : { dim: true }) });
        segments.push(...inline(box[2]));
      } else {
        segments.push(...inline(list[3]));
      }
      out.push(...wrapWords(wordsOf(segments), width));
      i += 1;
      continue;
    }
    if (i + 1 < src.length && line.includes('|')) {
      const header = splitRow(line);
      const delimiter = splitRow(src[i + 1]);
      if (header.length > 0 && delimiter.length === header.length && delimiter.every((cell) => DELIM_RE.test(cell))) {
        const aligns = delimiter.map(alignOf);
        const body: string[][] = [];
        i += 2;
        while (i < src.length && src[i].includes('|') && !/^\s*$/.test(src[i])) {
          body.push(splitRow(src[i]));
          i += 1;
        }
        out.push(...renderTable(header, aligns, body, width, style.ascii === true));
        continue;
      }
    }
    const paragraph: string[] = [line];
    i += 1;
    while (i < src.length
      && !/^\s*$/.test(src[i])
      && !/^```/.test(src[i])
      && !/^(#{1,6})\s/.test(src[i])
      && !/^\s*([-*_])\s*([-*_])\s*([-*_])\s*$/.test(src[i])
      && !/^\s*>\s?/.test(src[i])
      && !/^(\s*)([-*+]|\d+[.)])\s+/.test(src[i])) {
      paragraph.push(src[i]);
      i += 1;
    }
    out.push(...wrapWords(wordsOf(inline(paragraph.join(' '))), width));
  }
  // Blank rows are markers until here; a trailing one is not a paragraph break.
  while (out.length > 0 && out[out.length - 1]?.length === 0) out.pop();
  return out.map((row) => (row.length === 0 ? [{ text: '' }] : row));
}
