/**
 * Tiny syntax highlighter for code fences in the TUI.
 *
 * Pure module: no dependencies, no regex state, degrade-to-plain semantics.
 * Covers the small set of languages real agent output uses most
 * (js/ts/tsx/jsx, python, json, bash/sh); unknown languages fall back to
 * plain text so nothing renders worse than before.
 */

import type { MarkdownSegment } from './markdown.js';

/** Languages we can highlight; anything else renders plain. */
export function highlightable(lang: string | undefined): boolean {
  return lang !== undefined && HIGHLIGHTERS.has(normalize(lang));
}

function normalize(lang: string): string {
  const l = lang.toLowerCase();
  if (l === 'javascript' || l === 'node' || l === 'jsx') return 'js';
  if (l === 'typescript' || l === 'tsx') return 'ts';
  if (l === 'py') return 'python';
  if (l === 'sh' || l === 'shell' || l === 'zsh') return 'bash';
  return l;
}

const HIGHLIGHTERS = new Set(['js', 'ts', 'python', 'json', 'bash']);

/** Comment-to-end-of-line marker per language family. */
function commentMarker(lang: string): string {
  return lang === 'python' || lang === 'bash' ? '#' : '//';
}

const KEYWORDS: Record<string, readonly string[]> = {
  js: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'import', 'export', 'from', 'class', 'extends', 'new', 'await', 'async', 'try', 'catch', 'finally', 'throw', 'switch', 'case', 'break', 'continue', 'default', 'typeof', 'instanceof', 'in', 'of', 'yield', 'delete', 'void', 'static', 'get', 'set'],
  ts: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'import', 'export', 'from', 'class', 'extends', 'implements', 'interface', 'type', 'enum', 'new', 'await', 'async', 'try', 'catch', 'finally', 'throw', 'switch', 'case', 'break', 'continue', 'default', 'typeof', 'instanceof', 'in', 'of', 'yield', 'delete', 'void', 'static', 'public', 'private', 'protected', 'readonly', 'as', 'satisfies', 'keyof', 'namespace', 'declare', 'abstract'],
  python: ['def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'import', 'from', 'as', 'try', 'except', 'finally', 'raise', 'with', 'lambda', 'yield', 'pass', 'break', 'continue', 'and', 'or', 'not', 'in', 'is', 'global', 'nonlocal', 'assert', 'del', 'async', 'await'],
  json: [],
  bash: ['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'function', 'return', 'export', 'local', 'echo', 'exit', 'set', 'source', 'cd', 'rm', 'mkdir', 'cp', 'mv', 'npm', 'npx', 'git', 'node', 'python', 'pip'],
};

const TRUE_FALSE_NULL = new Set(['true', 'false', 'null', 'undefined', 'None', 'True', 'False', 'nil']);

/** Ink color names used for token classes. */
const COLORS = { keyword: 'magenta', string: 'green', number: 'yellow', comment: 'gray', literal: 'cyan' } as const;

interface Token {
  text: string;
  color?: string;
}

/** Word/punct tokenization with strings, comments, and numbers. */
function highlightGeneric(line: string, lang: string): Token[] {
  const out: Token[] = [];
  const comment = commentMarker(lang);
  const keywords = new Set(KEYWORDS[lang] ?? []);
  const re = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(#.*$|\/\/.*$)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][A-Za-z0-9_$]*)|(\s+)|(.)/g;
  let last = 0;
  const push = (text: string, color?: string): void => { if (text !== '') out.push({ text, color }); };
  for (const m of line.matchAll(re)) {
    const index = m.index ?? 0;
    if (index > last) push(line.slice(last, index), 'cyan');
    if (m[1] !== undefined) push(m[0], COLORS.string);
    else if (m[2] !== undefined) push(m[0], COLORS.comment);
    else if (m[3] !== undefined) push(m[0], COLORS.number);
    else if (m[4] !== undefined) {
      if (keywords.has(m[0])) push(m[0], COLORS.keyword);
      else if (TRUE_FALSE_NULL.has(m[0])) push(m[0], COLORS.literal);
      else push(m[0], 'cyan');
    } else if (m[5] !== undefined) push(m[0]);
    else push(m[0], 'cyan');
    last = index + m[0].length;
  }
  if (last < line.length) push(line.slice(last), 'cyan');
  return out;
}

/**
 * Highlight a whole code fence body into per-line segment arrays,
 * hard-slicing lines wider than `width` (segments split by character).
 */
export function highlightCode(code: readonly string[], lang: string | undefined, width: number): MarkdownSegment[][] {
  const l = lang !== undefined ? normalize(lang) : undefined;
  const can = l !== undefined && HIGHLIGHTERS.has(l);
  const out: MarkdownSegment[][] = [];
  for (const line of code) {
    let segments: MarkdownSegment[] = can ? highlightGeneric(line, l) : [{ text: line, color: 'cyan' }];
    // An overlong line wraps the way an editor soft-wraps: at a space or after
    // punctuation when there is one in the back half of the row, and with the
    // continuation indented past the line's own indentation. Cut at exactly
    // the width, `argv.includes('--verbose')` came out as a row ending in
    // "--verbose" and a row starting "') };" that read as a new line of code.
    const lead = /^\s*/.exec(line)?.[0].length ?? 0;
    const hang = Math.min(lead + 2, Math.floor(width / 2));
    let room = width;
    let first = true;
    while (length(segments) > room && segments.length > 0) {
      const [row, rest] = splitAt(segments, breakPoint(segments.map((seg) => seg.text).join(''), room));
      out.push(first ? row : [{ text: ' '.repeat(hang) }, ...row]);
      segments = rest;
      first = false;
      room = Math.max(1, width - hang);
    }
    const tail = segments.length > 0 ? segments : [{ text: '', color: 'cyan' }];
    out.push(first ? tail : [{ text: ' '.repeat(hang) }, ...tail]);
  }
  return out;
}

const length = (segments: readonly MarkdownSegment[]): number => segments.reduce((n, s) => n + s.text.length, 0);

/** Where to cut `text` so the head fits in `room`: after the last break
 *  character in the back half of the row, else at exactly `room`. */
function breakPoint(text: string, room: number): number {
  for (let i = room; i > Math.floor(room / 2); i -= 1) {
    const char = text[i - 1];
    if (char !== undefined && /[\s,;({[]/.test(char)) return i;
  }
  return room;
}

/** Split styled segments at a character offset. */
function splitAt(segments: readonly MarkdownSegment[], at: number): [MarkdownSegment[], MarkdownSegment[]] {
  const head: MarkdownSegment[] = [];
  const tail: MarkdownSegment[] = [];
  let seen = 0;
  for (const seg of segments) {
    if (seen >= at) tail.push(seg);
    else if (seen + seg.text.length <= at) head.push(seg);
    else {
      head.push({ ...seg, text: seg.text.slice(0, at - seen) });
      tail.push({ ...seg, text: seg.text.slice(at - seen) });
    }
    seen += seg.text.length;
  }
  return [head, tail];
}
