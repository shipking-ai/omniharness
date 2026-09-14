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
  return <Box flexDirection="column" marginTop={1} marginBottom={1}>
    <Text color={theme.attention} bold>
      {glyphs.attention} approval needed {glyphs.dot} {approval.tool}
    </Text>
    <Box flexDirection="row">
      <Text color={theme.muted}>{glyphs.rule} </Text>
      <Box flexDirection="column" flexGrow={1}>
        <Plain text={subject} width={Math.max(10, width - 2)} limit={3} />
      </Box>
    </Box>
    {approval.scopes.map((scope, index) => (
      <Text key={scope.id} color={theme.muted}>
        {'  '}{index + 1} {glyphs.dot} {clip(scope.label, Math.max(10, width - 6))}
      </Text>
    ))}
  </Box>;
}
