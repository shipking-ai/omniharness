/**
 * The settled transcript — the part of the session that goes into the
 * terminal's own scrollback.
 *
 * Rendered through Ink's `<Static>`, which writes each item exactly once and
 * never redraws it. That is why the state model only ever appends *finished*
 * entries here: a tool still running would be frozen mid-flight, and the run
 * lens shows it instead until it settles.
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
import { Output, Plain, Prose } from './prose.js';
import type { Glyphs, Theme } from '../theme/tokens.js';
import type { Entry, ToolRecord } from '../state/types.js';

export interface EntryProps {
  readonly entry: Entry;
  readonly width: number;
  readonly theme: Theme;
  readonly glyphs: Glyphs;
  readonly expanded: boolean;
}

/** Rows of tool output shown when a block is expanded. */
const OUTPUT_ROWS = 16;

export function TranscriptEntry({ entry, width, theme, glyphs, expanded }: EntryProps): React.ReactElement {
  switch (entry.kind) {
    case 'user':
      return <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row">
          <Text color={theme.accent} bold>{glyphs.caret} </Text>
          <Box flexDirection="column" flexGrow={1}>
            <Prose text={entry.text} width={width - 2} color={theme.accent} />
          </Box>
        </Box>
      </Box>;

    case 'assistant': {
      const meta = joinMeta([
        entry.provider !== undefined ? `via ${entry.provider}` : undefined,
        entry.fallback === true ? 'failover' : undefined,
        entry.model,
        entry.compression !== undefined
          ? `${Math.round(entry.compression.savedFraction * 100)}% context saved`
          : undefined,
      ], glyphs.dot);
      return <Box flexDirection="column" marginTop={1}>
        <Prose text={entry.text} width={width} />
        {meta !== '' ? <Text color={theme.muted}>{clip(meta, width)}</Text> : null}
      </Box>;
    }

    case 'reasoning':
      return <Box flexDirection="column" marginTop={1}>
        <Text color={theme.muted} bold>thinking</Text>
        <Prose text={entry.text} width={width} color={theme.muted} dim />
      </Box>;

    case 'tool':
      return <ToolBlock tool={entry.tool} width={width} theme={theme} glyphs={glyphs} expanded={expanded} />;

    case 'route':
      return <Text color={theme.warn}>
        {glyphs.dot} route failed over to {entry.decision.provider ?? 'another provider'}
        {entry.decision.reason !== undefined ? ` — ${clip(entry.decision.reason, Math.max(10, width - 40))}` : ''}
      </Text>;

    case 'notice': {
      const color = entry.level === 'error' ? theme.error
        : entry.level === 'warn' ? theme.warn
        : entry.level === 'success' ? theme.success
        : theme.muted;
      return <Box flexDirection="column" marginTop={entry.level === 'error' ? 1 : 0}>
        <Plain text={entry.text} width={width} color={color} />
      </Box>;
    }
  }
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
  tool, width, theme, glyphs, expanded,
}: { tool: ToolRecord; width: number; theme: Theme; glyphs: Glyphs; expanded: boolean }): React.ReactElement {
  const took = tool.endedAt !== undefined ? millis(tool.endedAt - tool.startedAt) : undefined;
  // The head owns the row: verb and subject first, then whatever room is left
  // goes to the one-line summary. Sizing the summary to the full width is what
  // makes rows wrap and the marker column collapse.
  //
  // A call whose arguments named no subject shows the verb alone: repeating the
  // tool's internal name beside its own verb ("diff git_diff") says nothing the
  // verb did not.
  const headWidth = Math.max(8, Math.floor((width - 2) * 0.55));
  const head = clip(tool.target === '' ? tool.verb : `${tool.verb} ${tool.target}`, headWidth);
  const rest = Math.max(0, width - 2 - head.length - 1);
  const tail = joinMeta([
    tool.outcome === 'denied' ? 'denied' : tool.summary,
    took,
    tool.agentId,
  ], glyphs.dot);

  return <Box flexDirection="column">
    <Text>
      <Marker state={toolMarker(tool)} glyphs={glyphs} theme={theme} />
      <Text color={tool.outcome === 'error' ? theme.error : undefined}>{head}</Text>
      {tail !== '' && rest > 4 ? <Text color={theme.muted}> {clip(tail, rest)}</Text> : null}
    </Text>
    {expanded && tool.detail !== undefined && tool.detail !== ''
      ? <Gutter theme={theme} glyphs={glyphs}>
          <Output text={tool.detail} width={Math.max(10, width - 2)} limit={OUTPUT_ROWS} />
        </Gutter>
      : null}
  </Box>;
}
