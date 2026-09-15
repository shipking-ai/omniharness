/**
 * Text rendering: markdown, plain wrapped text, and diffs.
 *
 * The parsers are pure modules under ../format; this file only turns their
 * styled segments into Ink nodes. Keeping the two apart is what lets the
 * wrapping and the syntax rules be tested at a hundred widths without a
 * terminal.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { renderMarkdown, type MarkdownSegment } from '../format/markdown.js';
import { diffSegments, looksLikeDiff } from '../format/diff.js';
import { activeGlyphs } from '../theme/tokens.js';

/**
 * One line of styled segments.
 *
 * An empty line is rendered as a single space rather than as nothing. Ink gives
 * a `Text` with no children no height at all, so every blank row the markdown
 * parser emits between paragraphs was being dropped on the way to the screen —
 * the parser was producing the breaks correctly and a long reply still arrived
 * as one unbroken wall, paragraphs, lists and code fences run together.
 */
export function Line({
  segments, color, dim,
}: { segments: readonly MarkdownSegment[]; color?: string; dim?: boolean }): React.ReactElement {
  // A blank row is one with nothing to print, whether that reaches here as an
  // empty list or as a single empty segment — the parser produces both. It is
  // drawn as a Box with an explicit height rather than as a Text holding a
  // space, because Ink trims a whitespace-only line back to nothing on the way
  // out and the row collapses again; Yoga honours the height.
  if (segments.every((segment) => segment.text === '')) return <Box height={1} />;
  return <Text color={color} dimColor={dim}>
    {segments.map((segment, index) => (
      <Text
        key={index}
        bold={segment.bold}
        italic={segment.italic}
        strikethrough={segment.strikethrough}
        underline={segment.underline}
        dimColor={segment.dim ?? dim}
        color={segment.color ?? color}
      >{segment.text}</Text>
    ))}
  </Text>;
}

/** Markdown, word-wrapped to `width`. */
export function Prose({
  text, width, color, dim, limit, ascii,
}: {
  text: string; width: number; color?: string; dim?: boolean; limit?: number; ascii?: boolean;
}): React.ReactElement {
  const rows = renderMarkdown(text, Math.max(8, width), { ascii: ascii === true });
  const shown = limit === undefined ? rows : rows.slice(-Math.max(1, limit));
  return <>{shown.map((segments, index) => <Line key={index} segments={segments} color={color} dim={dim} />)}</>;
}

/**
 * Word-wrap that honours existing newlines and hard-breaks a word too long to
 * fit. Used for text that must not be reinterpreted as markdown — tool output,
 * error messages, anything the model did not write as prose.
 */
export function wrap(text: string, width: number): string[] {
  const room = Math.max(1, width);
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph === '') { out.push(''); continue; }
    let current = '';
    for (const word of paragraph.split(' ')) {
      const candidate = current === '' ? word : `${current} ${word}`;
      if (candidate.length <= room) { current = candidate; continue; }
      if (current !== '') { out.push(current); current = ''; }
      let rest = word;
      while (rest.length > room) { out.push(rest.slice(0, room)); rest = rest.slice(room); }
      current = rest;
    }
    if (current !== '') out.push(current);
  }
  return out.length > 0 ? out : [''];
}

/** Literal text, wrapped, never parsed as markdown. */
export function Plain({
  text, width, color, dim, limit,
}: { text: string; width: number; color?: string; dim?: boolean; limit?: number }): React.ReactElement {
  const rows = wrap(text, width);
  const shown = limit === undefined ? rows : rows.slice(0, Math.max(1, limit));
  return <>{shown.map((line, index) => <Text key={index} color={color} dimColor={dim}>{line}</Text>)}</>;
}

/**
 * Tool output. A diff is rendered as a diff — that is the one shape where
 * colour genuinely carries meaning that the text does not.
 */
export function Output({
  text, width, limit,
}: { text: string; width: number; limit: number }): React.ReactElement {
  if (looksLikeDiff(text)) {
    return <>{diffSegments(text, width).slice(0, limit).map((segments, index) => (
      <Line key={index} segments={segments} />
    ))}</>;
  }
  const rows = text.split('\n');
  const shown = rows.slice(0, limit);
  return <>
    {shown.map((line, index) => <Text key={index} dimColor>{line.slice(0, width)}</Text>)}
    {rows.length > limit
      ? <Text dimColor>{activeGlyphs().ellipsis} {rows.length - limit} more line{rows.length - limit === 1 ? '' : 's'}</Text>
      : null}
  </>;
}
