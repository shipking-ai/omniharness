/**
 * Slash-prompt parsing and completion, over the same command table the palette
 * uses. Nothing is special-cased here: a command is reachable by typing its
 * name because it is in the table, not because a branch was added for it.
 */

import { COMMANDS, type Command } from './registry.js';

export interface SlashInput {
  /** The command the text names, when it names one. */
  readonly command?: Command;
  /** Everything after the command name, trimmed. */
  readonly argument: string;
  /** The raw text after the leading `/`, lower-cased. */
  readonly typed: string;
}

/** Whether the composer holds a command rather than a prompt. */
export const isSlash = (text: string): boolean => text.trimStart().startsWith('/');

/**
 * Resolve typed text to a command. Longest name first, so `mode build` is not
 * shadowed by a hypothetical `mode`, and an unknown name resolves to nothing
 * rather than to the closest guess — silently running a different command than
 * the one that was typed is worse than reporting the typo.
 */
export function parseSlash(text: string): SlashInput | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const typed = trimmed.slice(1).replace(/\s+/g, ' ').toLowerCase();
  const byLength = [...COMMANDS].sort((a, b) => b.name.length - a.name.length);
  for (const command of byLength) {
    if (typed === command.name) return { command, argument: '', typed };
    if (typed.startsWith(`${command.name} `)) {
      // The argument keeps the caller's original casing and spacing: session
      // names and paths are not lower-case.
      const original = trimmed.slice(1).trim();
      return { command, argument: original.slice(command.name.length).trim(), typed };
    }
  }
  return { argument: '', typed };
}

/** Commands whose name starts with what has been typed so far. */
export function completions(text: string): readonly Command[] {
  if (!isSlash(text)) return [];
  // The trailing space is kept: `/mode ` has already chosen `mode`, so it must
  // not still offer `/model`.
  const typed = text.trimStart().slice(1).toLowerCase();
  return COMMANDS
    .filter((command) => command.name.startsWith(typed))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The text the composer should hold after accepting a completion. A command
 * that takes an argument gets a trailing space so the next keystroke is the
 * argument rather than a correction.
 */
export function accept(command: Command): string {
  return `/${command.name}${command.argument !== undefined ? ' ' : ''}`;
}
