/**
 * The application root.
 *
 * It wires four things together and does nothing else: the store, the
 * controller, the terminal, and the keyboard. There is no domain logic in this
 * file — no event handling, no command implementations, no layout arithmetic —
 * because every one of those has a module of its own that can be tested
 * without a renderer.
 *
 * Two terminal decisions are load-bearing and deliberately kept:
 *
 *  - The interface renders in the primary buffer, not the alternate screen, so
 *    settled turns go into the terminal's real scrollback and are still there
 *    after quitting.
 *  - Ink's `<Static>` is the transcript. It writes each entry exactly once,
 *    which is what makes that scrollback possible, and is why the state model
 *    only appends entries that are already final.
 */

import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Static, useApp, useInput, useStdin, useStdout } from 'ink';
import type { MastraEngine } from '../agent/mastraEngine.js';
import { loadPromptHistory } from '../promptHistory.js';
import { ownVersion } from '../update.js';
import { Banner, bannerRows } from './components/banner.js';
import { ApprovalBanner } from './components/approval.js';
import { Composer, composerTextWidth } from './components/composer.js';
import { Opening, openingRows } from './components/opening.js';
import { Rail } from './components/rail.js';
import { HintLine, StatusLine } from './components/statusline.js';
import { TranscriptEntry } from './components/transcript.js';
import { PromptHistory } from './input/history.js';
import { fromInk, fromRaw } from './input/keymap.js';
import { KITTY_POP, KITTY_PUSH, KITTY_QUERY, isKittyQueryResponse } from './input/rawkeys.js';
import { focusOf, route as routeKey } from './input/router.js';
import { measure, plan as planHeight } from './layout/frame.js';
import { createController } from './runtime/controller.js';
import { createStore } from './state/store.js';
import { initialState } from './state/reducer.js';
import { railHasContent } from './state/selectors.js';
import { glyphs as resolveGlyphs, theme as resolveTheme } from './theme/tokens.js';
import { layoutEditor } from './input/editor.js';
import {
  BEL, SYNC_QUERY, isSyncOutputReply, osc9Notify, osc52Copy,
  shouldNudgeOnFinish, wrapSynchronizedOutput,
} from './term/caps.js';
import { AgentsView } from './views/agents.js';
import { OverlayView } from './views/overlay.js';
import { RouteView } from './views/route.js';
import { RunView } from './views/run.js';
import { SessionsView } from './views/sessions.js';
import { StrategyView } from './views/strategy.js';
import type { AppState, Entry, LensId } from './state/types.js';

export interface AppProps {
  readonly engine: MastraEngine;
}

/** How long the kitty probe waits before "no answer" becomes the answer. */
const KITTY_TIMEOUT_MS = 300;

type StaticItem = { kind: 'banner' } | { kind: 'entry'; entry: Entry };

export function App({ engine }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { stdin } = useStdin();

  const theme = useMemo(() => resolveTheme(), []);
  const glyphs = useMemo(() => resolveGlyphs(), []);
  const history = useMemo(() => new PromptHistory(), []);

  const store = useMemo(() => createStore(initialState(
    {
      workspace: engine.state.workspace.root,
      endpoint: engine.client.endpoint ?? 'omniroute',
      model: engine.state.activeModel,
      mode: engine.state.mode,
      permission: engine.state.permissionMode ?? 'ask',
      version: ownVersion(),
      skills: engine.skills.length,
      plugins: new Set(engine.skills.map((skill) => skill.source).filter((source) => source !== undefined)).size,
      mcpTools: engine.mcpTools.length,
      saved: [],
    },
    {
      columns: Math.max(40, stdout.columns ?? 80),
      rows: Math.max(8, stdout.rows ?? 24),
      kitty: null,
    },
  )), [engine, stdout]);

  const controller = useMemo(() => createController(engine, store), [engine, store]);
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);

  // A clock, ticked only while something is running: an idle session must not
  // repaint once a second forever.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (state.phase === 'idle') return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    // Unreferenced: a clock is not a reason for the process to stay alive. Ink
    // holds the loop open through stdin while the interface is mounted, and an
    // interval that outlived an unmount would keep a finished process running.
    timer.unref?.();
    return () => clearInterval(timer);
  }, [state.phase]);

  // -- startup: history, saved sessions, terminal probes ---------------------
  useEffect(() => {
    void loadPromptHistory()
      .then((entries) => history.load(entries))
      .catch(() => { /* history is best-effort */ });
    void controller.refreshSessions();
  }, [controller, history]);

  const restoreSync = useRef<(() => void) | null>(null);
  useEffect(() => {
    const onResize = (): void => store.dispatch({
      type: 'terminal/resize',
      columns: Math.max(40, stdout.columns ?? 80),
      rows: Math.max(8, stdout.rows ?? 24),
    });
    stdout.on('resize', onResize);
    stdout.write(KITTY_PUSH);

    // Two independent probes, not one shared listener with one deadline. Some
    // terminals answer the synchronized-output query long after any sensible
    // timeout, and a listener already torn down cannot catch a late reply — the
    // reply then reaches Ink's input handling and is typed into the composer.
    const onSyncProbe = (chunk: Buffer): void => {
      if (restoreSync.current !== null) return;
      if (!isSyncOutputReply(chunk.toString())) return;
      restoreSync.current = wrapSynchronizedOutput(
        stdout as unknown as { write: (chunk: unknown, ...rest: unknown[]) => boolean },
      );
      stdin?.off('data', onSyncProbe);
    };
    // The kitty question has to resolve either way, because it decides what the
    // hint line tells the user about Shift+Enter: no answer is itself an answer.
    let kittyTimer: ReturnType<typeof setTimeout> | undefined;
    const onKittyProbe = (chunk: Buffer): void => {
      if (!isKittyQueryResponse(chunk.toString())) return;
      if (kittyTimer !== undefined) clearTimeout(kittyTimer);
      stdin?.off('data', onKittyProbe);
      store.dispatch({ type: 'terminal/kitty', supported: true });
    };

    if (stdin) {
      stdin.on('data', onSyncProbe);
      stdin.on('data', onKittyProbe);
      kittyTimer = setTimeout(() => {
        stdin.off('data', onKittyProbe);
        store.dispatch({ type: 'terminal/kitty', supported: false });
      }, KITTY_TIMEOUT_MS);
      stdout.write(SYNC_QUERY);
      stdout.write(KITTY_QUERY);
    } else {
      store.dispatch({ type: 'terminal/kitty', supported: false });
    }

    const onExit = (): void => { controller.dispose(); stdout.write(KITTY_POP); };
    process.on('exit', onExit);
    return () => {
      if (kittyTimer !== undefined) clearTimeout(kittyTimer);
      stdin?.off('data', onSyncProbe);
      stdin?.off('data', onKittyProbe);
      stdout.off('resize', onResize);
      controller.dispose();
      process.off('exit', onExit);
      restoreSync.current?.();
      restoreSync.current = null;
      stdout.write(KITTY_POP);
    };
  }, [controller, stdin, stdout, store]);

  // -- a finished long run deserves a nudge ---------------------------------
  const previousPhase = useRef(state.phase);
  const runStarted = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (previousPhase.current === 'idle' && state.phase !== 'idle') runStarted.current = Date.now();
    if (previousPhase.current !== 'idle' && state.phase === 'idle') {
      const startedAt = runStarted.current;
      runStarted.current = undefined;
      if (startedAt !== undefined && shouldNudgeOnFinish(Date.now() - startedAt)) {
        try {
          stdout.write(osc9Notify('OmniHarness — run finished'));
          stdout.write(BEL);
        } catch { /* a nudge is best-effort */ }
      }
    }
    previousPhase.current = state.phase;
  }, [state.phase, stdout]);

  // -- layout ----------------------------------------------------------------
  // The rail is secondary context for the run view. Beside the plan or agents
  // lens it would draw the very list the user just opened, twice.
  const wantRail = state.lens === 'run' && state.overlay === undefined && railHasContent(state);
  const box = measure(state.terminal.columns, wantRail);
  const composerWidth = composerTextWidth(box.content);
  const composerLines = layoutEditor(state.composer.value, state.composer.cursor, composerWidth).lines.length;
  // The opening state: nothing said, nothing running, nothing modal over it.
  // It is the only state that gets the standing panel and the only one whose
  // command surface is pushed to the foot of the window.
  const opening = state.transcript.length === 0
    && state.phase === 'idle'
    && state.overlay === undefined
    && state.approval === undefined
    && state.lens === 'run';
  const heights = planHeight({
    rows: state.terminal.rows,
    composerLines,
    approval: state.approval !== undefined,
    overlay: state.overlay !== undefined,
    lensWanted: opening ? openingRows(state.session) : lensRowsWanted(state.lens, state),
    printed: bannerRows(state.session),
    opening,
  });

  // -- keyboard --------------------------------------------------------------
  // Rebuilt every render and mirrored into a ref: the two input listeners are
  // registered once, and the router has to see the state as it is now, not as
  // it was when they were attached.
  const deps = {
    state,
    dispatch: store.dispatch,
    controller,
    history,
    composerWidth,
    copy: (text: string): boolean => {
      const sequence = osc52Copy(text);
      if (sequence === null) return false;
      try { stdout.write(sequence); return true; } catch { return false; }
    },
    quit: exit,
  };
  // Mirrored into a ref after each commit rather than during render: the two
  // input listeners are registered once and must see the state as it is now,
  // and writing a ref while rendering is a side effect in the render pass.
  // Effects run before the loop can deliver the next keystroke, so there is no
  // window in which a handler sees a stale snapshot.
  const depsRef = useRef(deps);
  useEffect(() => { depsRef.current = deps; });

  useInput((value, key) => {
    const intent = fromInk(value, key);
    if (intent !== null) routeKey(intent, depsRef.current);
  });

  useEffect(() => {
    if (!stdin) return;
    const onData = (chunk: Buffer): void => {
      const intent = fromRaw(chunk.toString());
      if (intent !== null) routeKey(intent, depsRef.current);
    };
    stdin.on('data', onData);
    return () => { stdin.off('data', onData); };
  }, [stdin]);

  // -- render ----------------------------------------------------------------
  // One `<Static>`, ever: Ink keeps a single static node per app, so a second
  // one is silently dropped. The opening lines are the first item in it, which
  // is also what makes them print exactly once — the region is never remounted,
  // because the transcript behind it only ever grows.
  const items: StaticItem[] = useMemo(
    () => [{ kind: 'banner' as const }, ...state.transcript.map((entry) => ({ kind: 'entry' as const, entry }))],
    [state.transcript],
  );
  const focus = focusOf(state);

  return <Box flexDirection="column" width={state.terminal.columns} paddingLeft={box.gutter}>
    <Static items={items}>
      {(item) => item.kind === 'banner'
        ? <Banner key="banner" session={state.session} width={box.content} theme={theme} glyphs={glyphs} now={now} />
        : <TranscriptEntry
            key={item.entry.id}
            entry={item.entry}
            width={box.content}
            theme={theme}
            glyphs={glyphs}
          />}
    </Static>

    {/* The opening state's gap, and it goes *above* the standing panel rather
        than below it. Under it, the panel sat alone at the top of the window
        with twenty blank rows beneath — the masthead and the mode dial pinned
        to the ceiling and the command surface pinned to the floor, with nothing
        between them. Above it, the header stays at the top where a header
        belongs and the dial joins the composer, which is also where it belongs:
        the mode is what the next thing you type will run in. Zero in every
        other state, where content is what fills the window. */}
    {heights.pad > 0 ? <Box height={heights.pad} /> : null}

    <Box flexDirection="row">
      <Box flexDirection="column" width={box.content}>
        {state.overlay !== undefined
          ? <OverlayView
              overlay={state.overlay}
              state={state}
              width={box.content}
              rows={heights.overlay}
              theme={theme}
              glyphs={glyphs}
            />
          : opening
            ? <Opening
                session={state.session}
                width={box.content}
                rows={heights.lens}
                theme={theme}
                glyphs={glyphs}
              />
            : <Lens
                state={state}
                width={box.content}
                rows={heights.lens}
                streamRows={heights.stream}
                theme={theme}
                glyphs={glyphs}
                windows={controller.windows}
                now={now}
                compact={box.band === 'narrow'}
                railed={box.rail > 0}
              />}
      </Box>
      {box.rail > 0
        ? <Box marginLeft={box.railGap}>
            <Rail
              state={state}
              width={box.rail}
              rows={heights.lens + heights.stream}
              theme={theme}
              glyphs={glyphs}
            />
          </Box>
        : null}
    </Box>

    {state.approval !== undefined
      ? <ApprovalBanner approval={state.approval} width={box.content} theme={theme} glyphs={glyphs} />
      : null}

    <Composer
      composer={state.composer}
      width={box.content}
      mode={state.session.mode}
      phase={state.phase}
      theme={theme}
      glyphs={glyphs}
      failed={lastEntryFailed(state.transcript)}
    />
    {/* The instrument row and its hints span the window rather than stopping at
        the reading measure: they are read by position, not left to right. */}
    <StatusLine
      state={state}
      width={box.chrome}
      band={box.band}
      theme={theme}
      glyphs={glyphs}
      windows={controller.windows}
      now={now}
    />
    <HintLine
      state={state}
      focus={focus}
      width={box.chrome}
      theme={theme}
      glyphs={glyphs}
      kitty={state.terminal.kitty}
    />
  </Box>;
}

/**
 * Rows each lens would use if the terminal had them to give. The height plan
 * treats this as a request, not a claim: what actually fits is decided there.
 */
export function lensRowsWanted(lens: LensId, state: AppState): number {
  switch (lens) {
    case 'run':
      return Math.min(18, Math.min(6, state.live.tools.length)
        + (state.plan.length > 0 ? state.plan.length + 2 : 0)
        + (state.agents.length > 0 ? 4 : 0));
    case 'agents': return Math.min(18, state.agents.length + 6);
    case 'strategy': return Math.min(20, state.plan.length + 6);
    case 'route': return 18;
    case 'sessions': return Math.min(16, state.session.saved.length + 3);
  }
}

function Lens(props: {
  state: AppState;
  width: number; rows: number; streamRows: number;
  theme: ReturnType<typeof resolveTheme>;
  glyphs: ReturnType<typeof resolveGlyphs>;
  windows: ReturnType<typeof createController>['windows'];
  now: number; compact: boolean; railed: boolean;
}): React.ReactElement | null {
  const { state, width, rows, streamRows, theme, glyphs, windows, now, compact, railed } = props;
  switch (state.lens) {
    case 'run':
      return <RunView
        state={state} width={width} theme={theme} glyphs={glyphs}
        streamRows={streamRows} lensRows={rows} compact={compact} railed={railed}
      />;
    case 'agents':
      return <AgentsView state={state} width={width} rows={rows} theme={theme} glyphs={glyphs} now={now} />;
    case 'strategy':
      return <StrategyView state={state} width={width} rows={rows} theme={theme} glyphs={glyphs} />;
    case 'route':
      return <RouteView state={state} width={width} rows={rows} theme={theme} glyphs={glyphs} windows={windows} />;
    case 'sessions':
      return <SessionsView state={state} width={width} rows={rows} theme={theme} glyphs={glyphs} now={now} />;
  }
}

/** The caret turns red when the last thing that happened was a failure. */
function lastEntryFailed(transcript: readonly Entry[]): boolean {
  const last = transcript[transcript.length - 1];
  return last?.kind === 'notice' && last.level === 'error';
}

