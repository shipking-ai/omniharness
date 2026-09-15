/**
 * Where an intent goes, given what is focused.
 *
 * Focus is derived, never stored: an approval outranks an overlay, an overlay
 * outranks a lens with a list, and a lens outranks the composer. That ordering
 * is the whole of the routing policy, and having it in one place is why an
 * approval prompt can no longer be answered by a keystroke meant for the
 * composer — which the old interface allowed, because each overlay checked for
 * itself whether it should swallow a key.
 *
 * Not pure — it dispatches and calls the controller — but it is a plain
 * function over injected dependencies, so it is exercised in tests without a
 * renderer.
 */

import {
  deleteAt,
  deleteBefore,
  insertAt,
  lineEndAt,
  lineStartAt,
  moveHorizontal,
  moveVerticalWrapped,
  normalizePaste,
} from './editor.js';
import { accept, completions, isSlash, parseSlash } from '../commands/slash.js';
import { search } from '../commands/registry.js';
import { hasUnseenOutput } from '../state/selectors.js';
import type { CommandContext } from '../commands/registry.js';
import type { Intent } from './keymap.js';
import type { PromptHistory } from './history.js';
import type { AgentMode, PermissionMode } from '../../types/index.js';
import type { AppState } from '../state/types.js';

export type Focus = 'approval' | 'overlay' | 'lens' | 'composer';

/** What has the keyboard right now. Derived from state, so it cannot go stale. */
export function focusOf(state: AppState): Focus {
  if (state.approval !== undefined) return 'approval';
  if (state.overlay !== undefined) return 'overlay';
  if (state.lens === 'sessions' || state.lens === 'agents') return 'lens';
  return 'composer';
}

export interface RouterDeps extends CommandContext {
  readonly history: PromptHistory;
  /** Columns the composer wraps at — vertical cursor movement needs it. */
  readonly composerWidth: number;
}

const MODE_ORDER: readonly AgentMode[] = ['plan', 'build', 'research', 'crazy'];
const PERMISSION_ORDER: readonly PermissionMode[] = ['ask', 'acceptEdits', 'bypass'];

export function route(intent: Intent, deps: RouterDeps): void {
  const { state } = deps;
  switch (focusOf(state)) {
    case 'approval': return approvalKeys(intent, deps);
    case 'overlay': return overlayKeys(intent, deps);
    case 'lens': return lensKeys(intent, deps);
    case 'composer': return composerKeys(intent, deps);
  }
}

// ---------------------------------------------------------------------------
// Approval — deliberately narrow. Only an answer, an escape, or an interrupt
// gets through, so nothing typed at the composer can resolve a gate by accident.
// ---------------------------------------------------------------------------

function approvalKeys(intent: Intent, deps: RouterDeps): void {
  const approval = deps.state.approval;
  if (approval === undefined) return;
  if (intent.kind === 'submit') return deps.controller.answerApproval(true);
  if (intent.kind === 'escape' || intent.kind === 'interrupt') return deps.controller.answerApproval(false);
  if (intent.kind !== 'insert') return;
  const key = intent.text.toLowerCase();
  if (key === 'y') return deps.controller.answerApproval(true);
  if (key === 'n') return deps.controller.answerApproval(false);
  if (key === 'a' || key === 't') {
    const first = approval.scopes[0];
    return deps.controller.answerApproval(true, first?.id);
  }
  const digit = Number(key);
  if (Number.isInteger(digit) && digit >= 1 && digit <= approval.scopes.length) {
    return deps.controller.answerApproval(true, approval.scopes[digit - 1]?.id);
  }
}

// ---------------------------------------------------------------------------
// Overlay — the palette and the engine picker are the same list interaction.
// ---------------------------------------------------------------------------

function overlayKeys(intent: Intent, deps: RouterDeps): void {
  const { state, dispatch } = deps;
  const overlay = state.overlay;
  if (overlay === undefined) return;
  const size = overlay.kind === 'palette' ? search(overlay.query).length : overlay.items.length;

  switch (intent.kind) {
    case 'escape':
    case 'interrupt':
      return dispatch({ type: 'overlay/close' });
    case 'up':
      return dispatch({ type: 'overlay/move', delta: -1, size });
    case 'down':
      return dispatch({ type: 'overlay/move', delta: +1, size });
    case 'backspace':
      if (overlay.kind !== 'palette') return;
      return dispatch({ type: 'overlay/query', query: overlay.query.slice(0, -1) });
    case 'insert':
      if (overlay.kind !== 'palette') return;
      return dispatch({ type: 'overlay/query', query: overlay.query + intent.text });
    case 'submit': {
      if (overlay.kind === 'palette') {
        const command = search(overlay.query)[overlay.index];
        dispatch({ type: 'overlay/close' });
        // A command that needs an argument opens in the composer rather than
        // running with an empty one.
        if (command === undefined) return;
        if (command.argument !== undefined) {
          const text = accept(command);
          return dispatch({ type: 'composer/set', value: text, cursor: text.length });
        }
        return command.run(deps, '');
      }
      const item = overlay.items[overlay.index];
      dispatch({ type: 'overlay/close' });
      if (item !== undefined) void deps.controller.selectModel(item.id);
      return;
    }
    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// Lens — only lenses that carry a list take the arrows; everything else falls
// through so the composer keeps working while a lens is open.
// ---------------------------------------------------------------------------

function lensKeys(intent: Intent, deps: RouterDeps): void {
  const { state, dispatch } = deps;
  const size = state.lens === 'sessions' ? state.session.saved.length : state.agents.length;
  switch (intent.kind) {
    case 'up':
      if (size === 0) break;
      return dispatch({ type: 'lens/move', delta: -1, size });
    case 'down':
      if (size === 0) break;
      return dispatch({ type: 'lens/move', delta: +1, size });
    case 'escape':
      return dispatch({ type: 'lens/set', lens: 'run' });
    case 'submit': {
      // Enter in the sessions lens resumes; anywhere else it belongs to the
      // composer, which is what the user is usually typing into.
      if (state.lens !== 'sessions' || state.composer.value.trim() !== '') break;
      const chosen = state.session.saved[state.lensCursor];
      if (chosen !== undefined) void deps.controller.resume(chosen.name);
      return;
    }
    default:
      break;
  }
  composerKeys(intent, deps);
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function composerKeys(intent: Intent, deps: RouterDeps): void {
  const { state, dispatch, controller, history } = deps;
  const { value, cursor } = state.composer;
  const set = (next: { value: string; cursor: number }): void =>
    dispatch({ type: 'composer/set', value: next.value, cursor: next.cursor });

  switch (intent.kind) {
    case 'insert':
      history.reset();
      return set(insertAt(value, cursor, intent.text.length > 1 ? normalizePaste(intent.text) : intent.text));
    case 'newline':
      return set(insertAt(value, cursor, '\n'));
    case 'backspace':
      return set(deleteBefore(value, cursor));
    case 'delete':
      return set(deleteAt(value, cursor));
    case 'left':
      return set({ value, cursor: moveHorizontal(value, cursor, -1) });
    case 'right':
      return set({ value, cursor: moveHorizontal(value, cursor, +1) });
    case 'home':
      return set({ value, cursor: lineStartAt(value, cursor) });
    case 'end':
      return set({ value, cursor: lineEndAt(value, cursor) });

    case 'tab': {
      // Tab completes a command and does nothing else: a literal tab in a
      // prompt is not worth the cost of losing completion.
      const matches = completions(value);
      if (matches.length === 0) return;
      const text = accept(matches[0]!);
      return set({ value: text, cursor: text.length });
    }

    case 'up': {
      if (browsingHistory(state, history)) {
        const recalled = history.older();
        if (recalled !== undefined) return set({ value: recalled, cursor: recalled.length });
        return;
      }
      return set({ value, cursor: moveVerticalWrapped(value, cursor, -1, deps.composerWidth) });
    }
    case 'down': {
      if (history.browsing) {
        const recalled = history.newer();
        if (recalled !== undefined) return set({ value: recalled, cursor: recalled.length });
        return;
      }
      return set({ value, cursor: moveVerticalWrapped(value, cursor, +1, deps.composerWidth) });
    }

    case 'escape':
      if (state.lens !== 'run') return dispatch({ type: 'lens/set', lens: 'run' });
      if (value !== '') return dispatch({ type: 'composer/clear' });
      return;

    case 'interrupt':
      if (state.phase !== 'idle') return controller.cancel();
      return deps.quit();

    case 'submit':
      return submit(deps);

    case 'palette':
      return dispatch({ type: 'overlay/open', overlay: { kind: 'palette', query: '', index: 0 } });
    case 'cycleLens':
      return dispatch({ type: 'lens/cycle', direction: 1 });
    case 'models':
      return void controller.loadModels();
    case 'cycleMode': {
      const next = MODE_ORDER[(MODE_ORDER.indexOf(state.session.mode) + 1) % MODE_ORDER.length] as AgentMode;
      return controller.setMode(next);
    }
    case 'cyclePermission': {
      const at = PERMISSION_ORDER.indexOf(state.session.permission);
      const next = PERMISSION_ORDER[(at + 1) % PERMISSION_ORDER.length] as PermissionMode;
      return controller.setPermission(next);
    }
    case 'expandTool':
      return revealOutput(deps);
    case 'copyReply': {
      const command = search('copy')[0];
      command?.run(deps, '');
      return;
    }
  }
}

/**
 * Submit: a slash command runs, anything else becomes a prompt. An empty
 * composer submits nothing — pressing Enter on an empty line used to start a
 * run with no prompt at all.
 */
function submit(deps: RouterDeps): void {
  const { state, dispatch, controller, history } = deps;
  const raw = state.composer.value.trim();
  if (raw === '') return;

  if (isSlash(raw)) {
    const parsed = parseSlash(raw);
    dispatch({ type: 'composer/clear' });
    history.reset();
    if (parsed?.command === undefined) {
      dispatch({
        type: 'notice', level: 'warn', at: Date.now(),
        text: `unknown command '/${parsed?.typed ?? ''}' - Ctrl+K lists everything`,
      });
      return;
    }
    parsed.command.run(deps, parsed.argument);
    return;
  }

  history.remember(raw);
  controller.submit(raw);
}

/**
 * Up recalls a prompt only when there is nothing to move a caret through:
 * otherwise it moves the caret, which is what a multi-line composer needs.
 */
function browsingHistory(state: AppState, history: PromptHistory): boolean {
  if (history.size === 0) return false;
  if (state.phase !== 'idle') return false;
  return history.browsing || state.composer.value === '';
}

/**
 * Print the output of the newest call that has some and has not been printed
 * yet, walking backwards — so pressing the key repeatedly reveals successively
 * older calls, which is what "show me more" means here.
 *
 * It prints rather than expands on purpose. A row already in scrollback cannot
 * be redrawn (Ink writes each one once), so a toggle would change state and
 * nothing on screen. Appending the output below is both honest about what the
 * terminal can do and the thing a terminal user already expects from `cat`.
 */
function revealOutput(deps: RouterDeps): void {
  const { state, dispatch } = deps;
  for (let i = state.transcript.length - 1; i >= 0; i -= 1) {
    const entry = state.transcript[i]!;
    if (entry.kind !== 'tool') continue;
    if (!hasUnseenOutput(entry.tool, state.revealed)) continue;
    dispatch({ type: 'tool/reveal', id: entry.tool.id, at: Date.now() });
    return;
  }
  dispatch({
    type: 'notice', level: 'info', at: Date.now(),
    text: state.transcript.some((entry) => entry.kind === 'tool')
      ? 'nothing left to show - every call has already said what it had to'
      : 'no tool output yet',
  });
}
