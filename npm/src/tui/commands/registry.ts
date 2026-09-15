/**
 * One command table behind both the palette and the slash prompt.
 *
 * The old interface answered `/help` from a hand-written array and implemented
 * each command in a regex ladder inside the submit handler, so the list and the
 * behaviour drifted apart and nothing was discoverable without reading it. Here
 * a command is declared once — id, what it is called, what it does, whether it
 * takes an argument — and the palette, the completion and `/help` are all views
 * of the same table.
 */

import { capabilityReport } from '../components/banner.js';
import { activeGlyphs } from '../theme/tokens.js';
import type { AgentMode, PermissionMode } from '../../types/index.js';
import type { Controller } from '../runtime/controller.js';
import type { Dispatch } from '../state/store.js';
import type { AppState, LensId } from '../state/types.js';

export interface CommandContext {
  readonly state: AppState;
  readonly dispatch: Dispatch;
  readonly controller: Controller;
  /** Copy text to the system clipboard via OSC 52. Returns false when refused. */
  readonly copy: (text: string) => boolean;
  readonly quit: () => void;
}

export type CommandGroup = 'view' | 'session' | 'model' | 'mode' | 'run' | 'help';

export interface Command {
  readonly id: string;
  /** What the user types after `/`. */
  readonly name: string;
  readonly group: CommandGroup;
  readonly title: string;
  /** Shown beside the title in the palette. */
  readonly hint?: string;
  /** Placeholder for a required argument, e.g. `<name>`. */
  readonly argument?: string;
  run(context: CommandContext, argument: string): void;
}

const lens = (id: string, name: string, target: LensId, title: string, hint: string): Command => ({
  id, name, group: 'view', title, hint,
  run: ({ dispatch }) => dispatch({ type: 'lens/set', lens: target }),
});

const mode = (value: AgentMode, hint: string): Command => ({
  id: `mode.${value}`, name: `mode ${value}`, group: 'mode', title: `Switch to ${value} mode`, hint,
  run: ({ controller }) => controller.setMode(value),
});

/**
 * Permission commands are named in kebab-case, not in the enum's camelCase:
 * a command name is typed, and `/perms acceptEdits` asks the user to guess a
 * capital letter.
 */
const permission = (value: PermissionMode, name: string, title: string, hint: string): Command => ({
  id: `perm.${value}`, name: `perms ${name}`, group: 'mode', title, hint,
  run: ({ controller }) => controller.setPermission(value),
});

export const COMMANDS: readonly Command[] = [
  lens('view.run', 'run', 'run', 'Run', 'the task, the response, the work in flight'),
  lens('view.agents', 'agents', 'agents', 'Agents', 'parallel workers and what each is doing'),
  lens('view.strategy', 'plan', 'strategy', 'Plan', 'steps, progress, what is blocked'),
  lens('view.route', 'route', 'route', 'Route', 'OmniRoute decision, fallbacks, measured cost'),
  lens('view.sessions', 'sessions', 'sessions', 'Sessions', 'resume or inspect a saved session'),

  {
    id: 'model.pick', name: 'model', group: 'model',
    title: 'Choose an engine', hint: 'combos and auto routes from OmniRoute',
    run: ({ controller }) => { void controller.loadModels(); },
  },

  // These read on the opening screen as well as in the palette, so each says
  // what the harness will *do* with a task in that mode, in the same grammar.
  mode('plan', 'map the work, change nothing'),
  mode('build', 'implement, verify, repair'),
  mode('research', 'read and explain, touch nothing'),
  mode('crazy', 'fan out across parallel agents'),

  permission('ask', 'ask', 'Approvals: ask every time', 'prompt before every high-risk call'),
  permission('acceptEdits', 'accept-edits', 'Approvals: accept edits', 'file edits go through; commands still ask'),
  permission('bypass', 'bypass', 'Approvals: bypass', 'nothing is gated - use deliberately'),

  {
    id: 'session.new', name: 'clear', group: 'session',
    title: 'Start a fresh conversation', hint: 'drops the transcript and the plan',
    run: ({ controller }) => { void controller.clear(); },
  },
  {
    id: 'session.save', name: 'save', group: 'session', argument: '<name>',
    title: 'Save this session', hint: 'snapshot the transcript and plan under a name',
    run: ({ controller, dispatch }, argument) => {
      const name = argument.trim();
      if (name === '') {
        dispatch({ type: 'notice', level: 'warn', at: Date.now(), text: '/save needs a name' });
        return;
      }
      void controller.save(name);
    },
  },
  {
    id: 'session.forget', name: 'forget', group: 'session', argument: '<name>',
    title: 'Delete a saved session', hint: 'removes one snapshot',
    run: ({ controller, dispatch }, argument) => {
      const name = argument.trim();
      if (name === '') {
        dispatch({ type: 'notice', level: 'warn', at: Date.now(), text: '/forget needs a name' });
        return;
      }
      void controller.forget(name);
    },
  },
  {
    id: 'session.resume', name: 'resume', group: 'session', argument: '<name>',
    title: 'Resume a saved session', hint: 'no name opens the session list',
    run: ({ controller, dispatch }, argument) => {
      const name = argument.trim();
      if (name === '') {
        void controller.refreshSessions();
        dispatch({ type: 'lens/set', lens: 'sessions' });
        return;
      }
      void controller.resume(name);
    },
  },

  {
    id: 'session.attach', name: 'attach', group: 'session', argument: '<files>',
    title: 'Attach files to the next prompt', hint: 'images travel inline; other files are named',
    run: ({ controller, dispatch }, argument) => {
      const paths = argument.split(/\s+/).filter((part) => part !== '');
      if (paths.length === 0) {
        dispatch({ type: 'notice', level: 'warn', at: Date.now(), text: '/attach needs at least one path' });
        return;
      }
      void controller.attach(paths);
    },
  },

  {
    id: 'run.find', name: 'find', group: 'run', argument: '<text>',
    title: 'Search this session', hint: 'matches in the transcript, newest first',
    run: ({ state, dispatch }, argument) => {
      const needle = argument.trim().toLowerCase();
      if (needle === '') {
        dispatch({ type: 'notice', level: 'warn', at: Date.now(), text: '/find needs something to look for' });
        return;
      }
      const hits = state.transcript.filter((entry) => textOf(entry).toLowerCase().includes(needle));
      if (hits.length === 0) {
        dispatch({ type: 'notice', level: 'info', at: Date.now(), text: `no match for "${argument.trim()}"` });
        return;
      }
      dispatch({
        type: 'notice', level: 'info', at: Date.now(),
        text: `${hits.length} match${hits.length === 1 ? '' : 'es'} for "${argument.trim()}"`,
      });
      for (const entry of hits.slice(-6)) {
        dispatch({
          type: 'notice', level: 'info', at: Date.now(),
          text: `  ${entry.kind} ${activeGlyphs().dot} ${textOf(entry).replace(/\s+/g, ' ').slice(0, 96)}`,
        });
      }
    },
  },

  {
    id: 'run.cancel', name: 'cancel', group: 'run',
    title: 'Cancel the running task', hint: 'same as Ctrl+C while a run is in flight',
    run: ({ controller }) => controller.cancel(),
  },
  {
    id: 'run.copy', name: 'copy', group: 'run',
    title: 'Copy the last reply', hint: 'writes the clipboard over OSC 52',
    run: ({ state, copy, dispatch }) => {
      const reply = [...state.transcript].reverse().find((entry) => entry.kind === 'assistant');
      if (reply === undefined || reply.kind !== 'assistant') {
        dispatch({ type: 'notice', level: 'warn', at: Date.now(), text: 'nothing to copy yet' });
        return;
      }
      dispatch(copy(reply.text)
        ? { type: 'notice', level: 'success', at: Date.now(), text: `copied ${reply.text.length} characters` }
        : { type: 'notice', level: 'warn', at: Date.now(), text: 'reply is too large for the clipboard' });
    },
  },

  {
    // Where the capability metadata went when it came off the opening screen.
    // A count that never changes during a session does not earn a permanent
    // row; it earns a command.
    id: 'help.skills', name: 'skills', group: 'help',
    title: 'What this session can reach', hint: 'skills, plugins and MCP tools loaded',
    run: ({ state, dispatch }) => dispatch({
      type: 'notice', level: 'info', at: Date.now(), text: capabilityReport(state.session),
    }),
  },
  {
    id: 'help.keys', name: 'help', group: 'help',
    title: 'Show commands and keys', hint: 'everything the palette offers',
    run: ({ dispatch }) => dispatch({ type: 'overlay/open', overlay: { kind: 'palette', query: '', index: 0 } }),
  },
  {
    id: 'app.quit', name: 'quit', group: 'help',
    title: 'Quit OmniHarness', hint: 'Ctrl+C when nothing is running',
    run: ({ quit }) => quit(),
  },
];

/** The searchable text of a transcript entry, whatever shape it is. */
function textOf(entry: AppState['transcript'][number]): string {
  switch (entry.kind) {
    case 'user':
    case 'assistant':
    case 'reasoning':
    case 'notice':
      return entry.text;
    case 'tool':
    case 'output':
      return `${entry.tool.verb} ${entry.tool.target} ${entry.tool.summary ?? ''} ${entry.tool.detail ?? ''}`;
    case 'route':
      return `${entry.decision.provider ?? ''} ${entry.decision.reason ?? ''}`;
  }
}

export const byId = (id: string): Command | undefined => COMMANDS.find((command) => command.id === id);

/**
 * Rank commands against a palette query. Matching is on the command's own
 * words: a prefix of the name or the title beats a match in the middle, so
 * typing "ro" reaches Route before it reaches "Approvals: bypass".
 */
export function search(query: string): readonly Command[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return COMMANDS;
  const scored: { command: Command; score: number }[] = [];
  for (const command of COMMANDS) {
    const name = command.name.toLowerCase();
    const title = command.title.toLowerCase();
    const hint = command.hint?.toLowerCase() ?? '';
    let score = -1;
    if (name.startsWith(needle)) score = 4;
    else if (title.startsWith(needle)) score = 3;
    else if (name.includes(needle)) score = 2;
    else if (title.includes(needle)) score = 1;
    // A hint matches only at the start of one of its words: matching anywhere
    // made "rou" find "file edits go through", which is not a route command.
    else if (hint.split(/[^a-z0-9]+/).some((word) => word.startsWith(needle))) score = 0;
    if (score >= 0) scored.push({ command, score });
  }
  return scored
    .sort((a, b) => (b.score - a.score) || a.command.name.localeCompare(b.command.name))
    .map((entry) => entry.command);
}
