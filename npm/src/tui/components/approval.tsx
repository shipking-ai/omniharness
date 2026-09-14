/**
 * The approval gate.
 *
 * The one thing in this interface that is allowed to shout. It sits directly
 * above the composer, takes the warning colour on a full-width band, and names
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
import { Gutter } from './atoms.js';
import { Plain } from './prose.js';
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

export function ApprovalBanner({
  approval, width, theme, glyphs,
}: { approval: PendingApproval; width: number; theme: Theme; glyphs: Glyphs }): React.ReactElement {
  const subject = describeCall(approval);
  // No bottom margin: the composer under it opens with one, and two gaps left
  // the band floating between them instead of sitting against the input it is
  // blocking.
  return <Box flexDirection="column" marginTop={1}>
    {/* The one element besides the user's own task that is given a surface.
        Everything else on screen competes for the eye at roughly equal weight,
        which is right while work is flowing past and wrong at the moment the
        run has stopped and is waiting on a person. The tool is named, not just
        the arguments: which capability is being asked for is the
        security-relevant half of the question, and "run a command" and "write a
        file" are not the same decision. */}
    <Text backgroundColor={theme.surface} color={theme.attention} bold>
      {` ${glyphs.attention} approval needed  ${approval.tool} `.padEnd(width)}
    </Text>
    <Gutter theme={theme} ascii={glyphs.ascii}>
      <Plain text={subject} width={Math.max(10, width - 2)} limit={3} />
    </Gutter>
    {/* The scopes are answers to one question, so they are set as a choice
        list: the key that picks each one, then what picking it would mean. The
        numbers carry the accent because the number is what gets typed. */}
    {approval.scopes.map((scope, index) => (
      <Text key={scope.id}>
        {'  '}<Text color={theme.accent} bold>{index + 1}</Text>
        <Text color={theme.muted}>  {clip(scope.label, Math.max(10, width - 6))}</Text>
      </Text>
    ))}
  </Box>;
}
