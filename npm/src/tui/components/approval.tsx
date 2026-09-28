/**
 * The approval gate.
 *
 * The one thing in this interface that is allowed to shout. It sits directly
 * above the composer, takes the warning colour on a framed dialog, and names
 * the exact call being asked about — the old prompt was a dim line among other
 * dim lines below the input, and was easy to scroll past while the run sat
 * blocked waiting for an answer.
 *
 * It renders what the engine asked; it never decides. Answering happens in the
 * router, which sends the decision back through the controller to the engine's
 * own approval handler, so nothing here can approve anything on its own.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { clip } from '../format/clip.js';
import { wrap } from './prose.js';
import { tildePath } from '../format/units.js';
import type { Glyphs, Theme } from '../theme/tokens.js';
import type { PendingApproval } from '../state/types.js';

/**
 * The subject of the call in the form the user recognises: the command for a
 * shell call, the path for a file write, otherwise the arguments as given.
 */
export function describeCall(approval: PendingApproval): string {
  const input = approval.input;
  const command = input.command;
  if (typeof command === 'string' && command.trim() !== '') return command.trim();
  const path = input.path;
  if (typeof path === 'string' && path.trim() !== '') return path.trim();
  try {
    const json = JSON.stringify(input);
    return json === '{}' ? '(no arguments)' : json;
  } catch {
    return '(arguments could not be shown)';
  }
}

/** Rows of the subject shown before it is cut. */
const SUBJECT_ROWS = 3;

/** Columns inside the dialog's border and padding. */
const inner = (width: number): number => Math.max(10, width - 4);

/** The subject, wrapped to the dialog and cut to {@link SUBJECT_ROWS}. */
function subjectLines(approval: PendingApproval, width: number): readonly string[] {
  return wrap(describeCall(approval), Math.max(8, inner(width) - 2)).slice(0, SUBJECT_ROWS);
}

/**
 * Rows the dialog occupies, margin included. The height plan reserves exactly
 * this: a dialog taller than planned pushes the frame past the viewport, which
 * is the one thing that makes Ink's redraw eat the transcript.
 */
export function approvalRows(approval: PendingApproval, width: number, compact = false): number {
  const subject = subjectLines(approval, width).length;
  // compact: margin, title, subject, scopes
  if (compact) return 1 + 1 + subject + approval.scopes.length;
  // margin, top border, title, subject, breathing row, scopes, bottom border
  return 1 + 1 + 1 + subject + 1 + approval.scopes.length + 1;
}

export function ApprovalBanner({
  approval, width, theme, glyphs, workspace, compact = false,
}: {
  approval: PendingApproval; width: number; theme: Theme; glyphs: Glyphs;
  /** Where the call will run, so the dialog can say so. */
  workspace?: string;
  /**
   * Drop the frame and the breathing row. For a window too short for the
   * dialog, the streaming floor and the composer at once: three rows the live
   * region cannot spare without growing past the viewport.
   */
  compact?: boolean;
}): React.ReactElement {
  const room = inner(width);
  const lines = subjectLines(approval, width);
  const where = workspace !== undefined ? ` ${glyphs.dot} ${tildePath(workspace)}` : '';
  // A framed dialog, the way Crush and Mistral Vibe ask: the one place in this
  // interface that gets a border, because it is the one moment the run has
  // stopped and is waiting on a person. The tool is named, not just the
  // arguments: which capability is being asked for is the security-relevant
  // half of the question, and "run a command" and "write a file" are not the
  // same decision. It sits directly above the composer it is blocking.
  return <Box
    flexDirection="column"
    marginTop={1}
    {...(compact ? {} : { borderStyle: glyphs.ascii ? 'classic' as const : 'round' as const, borderColor: theme.attention, paddingX: 1 })}
    width={width}
  >
    <Text>
      <Text color={theme.attention} bold>{glyphs.attention} approval needed</Text>
      <Text color={theme.muted}>{'  '}{clip(`${approval.tool}${where}`, Math.max(6, room - 18))}</Text>
    </Text>
    {/* The subject on a filled block, like the command box in Crush's dialog:
        this is the text being approved, and it should look like text, not
        like part of the question around it. */}
    {lines.map((line, index) => (
      <Text key={index} backgroundColor={theme.surface}>{` ${line} `.padEnd(room)}</Text>
    ))}
    {compact ? null : <Box height={1} />}
    {/* The scopes are answers to one question, so they are set as a choice
        list: the key that picks each one, then what picking it would mean. The
        numbers carry the accent because the number is what gets typed. */}
    {approval.scopes.map((scope, index) => (
      <Text key={scope.id}>
        <Text color={theme.accent} bold>{index + 1}</Text>
        <Text color={theme.muted}>  {clip(scope.label, Math.max(10, room - 3))}</Text>
      </Text>
    ))}
  </Box>;
}
