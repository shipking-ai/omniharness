/**
 * The settled transcript — the part of the session that goes into the
 * terminal's own scrollback.
 *
 * Rendered through Ink's `<Static>`, which writes each item exactly once and
 * never redraws it. That is why the state model only ever appends *finished*
 * entries here: a tool still running would be frozen mid-flight, and the run
 * lens shows it instead until it settles. It is also why revealing a call's
 * output appends an `output` entry below rather than reopening the row above.
 *
 * Hierarchy is carried by position and weight, not by boxes. The user's words
 * get the accent and a marker; the assistant's answer gets the full measure and
 * no label at all, because the answer is the thing being read; everything else
 * is secondary and dim.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { clip } from '../format/clip.js';
import { millis } from '../format/units.js';
import { Gutter, Marker, joinMeta, type MarkerState } from './atoms.js';
import { Output, Plain, Prose, wrap } from './prose.js';
import { printsOutputInline } from '../state/selectors.js';
import type { Glyphs, Theme } from '../theme/tokens.js';
import type { Entry, ToolRecord } from '../state/types.js';

export interface EntryProps {
  readonly entry: Entry;
  readonly width: number;
  readonly theme: Theme;
  readonly glyphs: Glyphs;
}

/**
 * Rows printed when a call's output is revealed. High on purpose: the block
 * goes into scrollback, where the terminal can scroll it, and the engine has
 * already bounded what it sends. This is a guard against a pathological line
 * count, not an editorial cut.
 */
const OUTPUT_ROWS = 200;
/**
 * Rows of a failure shown without being asked. An error you have to press a key
 * to read is an error most people never read; a success you have to ask for is
 * just tidy.
 */
const ERROR_PREVIEW_ROWS = 8;
/**
 * Below this a turn's wall time is not information anybody wants. "63ms" under
 * a reply is a stopwatch reading, not a fact about the work, and it puts a row
 * of chrome under turns that plainly did not take any time.
 */
const WORTH_TIMING_MS = 1000;

export function TranscriptEntry({ entry, width, theme, glyphs }: EntryProps): React.ReactElement {
  switch (entry.kind) {
    case 'user': {
      // The task owns its turn. Everything below it — narrative, calls,
      // output, the answer — is the harness working on this, and a reader
      // scrolling back is looking for exactly these rows. A caret and an accent
      // colour were not enough to find them among the tool rows, which carry
      // markers and colour of their own; the band is, and it costs no rows.
      //
      // Each line is padded to the measure so the band is a rectangle rather
      // than a ragged right edge, and the marker sits inside it.
      const lines = wrap(entry.text, Math.max(8, width - 4));
      return <Box flexDirection="column" marginTop={1}>
        {lines.map((line, index) => (
          <Text
            key={index}
            backgroundColor={theme.surface}
            color={theme.accent}
            bold
          >{` ${index === 0 ? glyphs.caret : ' '} ${line} `.padEnd(width)}</Text>
        ))}
      </Box>;
    }

    case 'assistant': {
      // What this turn cost, once it is over. The status line counts the clock
      // up while a turn runs and then loses it; a reader scrolling back through
      // a long session has no way to tell a turn that took two seconds from one
      // that took four minutes. Wall time only — tokens and spend are measured
      // per session rather than per turn, and splitting a session total across
      // turns would be inventing the split.
      const meta = joinMeta([
        entry.showRoute === true && entry.provider !== undefined ? `via ${entry.provider}` : undefined,
        entry.showRoute === true && entry.fallback === true ? 'failover' : undefined,
        entry.showRoute === true ? entry.model : undefined,
        entry.tookMs !== undefined && entry.tookMs >= WORTH_TIMING_MS ? millis(entry.tookMs) : undefined,
        entry.compression !== undefined
          ? `${Math.round(entry.compression.savedFraction * 100)}% context saved`
          : undefined,
      ], glyphs.dot);
      return <Box flexDirection="column" marginTop={1}>
        <Prose ascii={glyphs.ascii} text={entry.text} width={width} />
        {meta !== '' ? <Text color={theme.muted}>{clip(meta, width)}</Text> : null}
      </Box>;
    }

    case 'reasoning':
      return <Box flexDirection="column" marginTop={1}>
        <Text color={theme.muted} bold>thinking</Text>
        <Prose ascii={glyphs.ascii} text={entry.text} width={width} color={theme.muted} dim />
      </Box>;

    case 'tool':
      return <ToolBlock tool={entry.tool} width={width} theme={theme} glyphs={glyphs} />;

    case 'output':
      return <Box flexDirection="column">
        <Text color={theme.muted}>
          {'  '}output {glyphs.dot} {clip(`${entry.tool.verb} ${entry.tool.target}`.trim(), Math.max(8, width - 12))}
        </Text>
        <Gutter theme={theme} ascii={glyphs.ascii}>
          <Output text={entry.tool.detail ?? ''} width={Math.max(10, width - 2)} limit={OUTPUT_ROWS} />
        </Gutter>
      </Box>;

    case 'route':
      return <Text color={theme.warn}>
        {glyphs.dot} route failed over to {entry.decision.provider ?? 'another provider'}
        {entry.decision.reason !== undefined ? ` ${glyphs.dash} ${clip(entry.decision.reason, Math.max(10, width - 40))}` : ''}
      </Text>;

    case 'notice': {
      const color = entry.level === 'error' ? theme.error
        : entry.level === 'warn' ? theme.warn
        : entry.level === 'success' ? theme.success
        : theme.muted;
      // The marker, not the colour, is what carries the severity: a terminal
      // with NO_COLOR set still has to be able to tell a failure from a note.
      const marker = entry.level === 'error' ? glyphs.failed
        : entry.level === 'warn' ? glyphs.attention
        : entry.level === 'success' ? glyphs.done
        : glyphs.dot;
      return <Box flexDirection="row" marginTop={entry.level === 'error' ? 1 : 0}>
        <Text color={color}>{marker} </Text>
        <Box flexDirection="column" flexGrow={1}>
          <Plain text={entry.text} width={Math.max(8, width - 2)} color={color} />
        </Box>
      </Box>;
    }
  }
}

/**
 * The subject of the row: what was done and to what.
 *
 * A call with no subject shows the verb alone, because repeating the tool's
 * internal name beside its own verb ("diff git_diff") says nothing the verb did
 * not. And a call whose summary is already a sentence about the verb drops the
 * verb entirely: `index_workspace` returning "indexed 0 entries" rendered as
 * "index  indexed 0 entries", which reads like a stutter. The summary is the
 * better half of that pair — it has the number in it.
 */
export function headOf(tool: ToolRecord): string {
  if (tool.target !== '') return `${tool.verb} ${tool.target}`;
  const first = (tool.summary ?? '').trimStart().split(/[\s,.:]/)[0]?.toLowerCase() ?? '';
  const verb = tool.verb.toLowerCase();
  // Same stem, not merely the same start: "read" must not swallow "ready", and
  // a four-letter floor keeps short verbs from matching half the dictionary.
  const shares = verb.length >= 3 && first.length >= verb.length && first.startsWith(verb);
  return shares ? '' : tool.verb;
}

export function toolMarker(tool: ToolRecord): MarkerState {
  switch (tool.outcome) {
    case 'running': return 'running';
    case 'ok': return 'done';
    case 'error': return 'failed';
    case 'denied': return 'denied';
  }
}

/**
 * One tool call: a single row by default, its output behind Ctrl+T.
 *
 * The head is `<marker> verb target … summary`. A command is shown as the
 * command, a file operation as the path — the thing the reader is looking for
 * is the subject, not the tool's internal name.
 */
export function ToolBlock({
  tool, width, theme, glyphs,
}: { tool: ToolRecord; width: number; theme: Theme; glyphs: Glyphs }): React.ReactElement {
  const took = tool.endedAt !== undefined ? millis(tool.endedAt - tool.startedAt) : undefined;
  // The head owns the row: verb and subject first, then whatever room is left
  // goes to the one-line summary. Sizing the summary to the full width is what
  // makes rows wrap and the marker column collapse.
  //
  // A call whose arguments named no subject shows the verb alone: repeating the
  // tool's internal name beside its own verb ("diff git_diff") says nothing the
  // verb did not.
  const headWidth = Math.max(8, Math.floor((width - 2) * 0.55));
  const head = clip(headOf(tool), headWidth);
  // With no head, the summary *is* the row and takes the foreground; the timing
  // and the worker stay behind it. Leaving it muted behind an empty column gave
  // the row a leading double space and no subject at all.
  const lead = head === '' ? clip(tool.summary ?? tool.verb, headWidth) : head;
  const rest = Math.max(0, width - 2 - lead.length - 1);
  const tail = joinMeta(head === ''
    ? [took, tool.agentId]
    : [tool.outcome === 'denied' ? 'denied' : tool.summary, took, tool.agentId],
  glyphs.dot);
  // A failure shows its output without being asked — but only when the output
  // says more than the row already did. Repeating a one-line error underneath
  // itself is noise, not evidence.
  const inlineOutput = printsOutputInline(tool);

  return <Box flexDirection="column">
    <Text>
      <Marker state={toolMarker(tool)} glyphs={glyphs} theme={theme} />
      <Text color={tool.outcome === 'error' ? theme.error : undefined}>{lead}</Text>
      {tail !== '' && rest > 4 ? <Text color={theme.muted}> {clip(tail, rest)}</Text> : null}
    </Text>
    {inlineOutput
      ? <Gutter theme={theme} ascii={glyphs.ascii}>
          <Output text={tool.detail ?? ''} width={Math.max(10, width - 2)} limit={ERROR_PREVIEW_ROWS} />
        </Gutter>
      : null}
  </Box>;
}
