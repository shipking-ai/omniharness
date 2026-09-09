// The desktop shell.
//
// The web view renders the event stream as a scrollback, which is the right
// shape for a tab. A window has room for the questions a scrollback cannot
// answer — where the run spent its time, what ran concurrently, what actually
// answered — so this surface pairs the log with a timeline and a route graph
// built from the same events, plus a details pane holding the payload each log
// line summarises.
//
// It also reads past sessions. The session list used to be navigation that
// navigated nowhere: clicking a row set the id for the *next* run and changed
// nothing on screen, so there was no way to see what had happened in a run you
// did not watch live.
//
// Everything that talks to the harness is in core.js; the graph is route.js.

const $ = (id) => document.getElementById(id);

const state = {
  events: [],
  approvals: [],
  steps: [],              // in the order they opened
  open: new Map(),        // key -> step, while it is still running
  t0: 0,
  taskId: '',
  sessionId: '',
  running: false,
  runStart: 0,
  selected: null,
  filter: '',
  notified: new Set(),
  label: '',              // the prompt of the run being watched
  replay: null,           // the session being read, when not live
  seen: new Set(),        // event ids already drawn, so only new rows animate
};

let route = null;

// ── Steps ────────────────────────────────────────────────────────────────
//
// A step is an opener event and the closer that answers it. The pairing is
// declared rather than inferred: guessing from name shape would pair
// `agent.updated` with `agent.completed` and report a duration that is really
// the gap between two progress reports.
const OPENERS = {
  'task.started': { kind: 'task', depth: 0 },
  'agent.created': { kind: 'agent', depth: 1 },
  'agent.started': { kind: 'agent', depth: 1 },
  'model.requested': { kind: 'model', depth: 2 },
  'tool.requested': { kind: 'tool', depth: 2 },
  'tool.started': { kind: 'tool', depth: 2 },
  'approval.requested': { kind: 'approval', depth: 2 },
  'evaluation.started': { kind: 'evaluation', depth: 1 },
  'repair.started': { kind: 'repair', depth: 1 },
};

const CLOSERS = {
  'task.completed': 'task', 'task.failed': 'task', 'task.cancelled': 'task',
  'agent.completed': 'agent', 'agent.failed': 'agent', 'agent.cancelled': 'agent',
  'model.responded': 'model', 'model.failed': 'model',
  'tool.completed': 'tool', 'tool.failed': 'tool',
  'approval.granted': 'approval', 'approval.denied': 'approval',
  'evaluation.completed': 'evaluation',
  'repair.completed': 'repair',
};

// keyOf identifies the thing a step is about, so an opener and its closer land
// on the same row. A tool call is keyed by agent *and* tool name because one
// agent runs several tools; a model call is keyed by agent alone because an
// agent has one call in flight at a time.
function keyOf(kind, e) {
  const d = e.data || {};
  const agent = e.agentId || d.agentId || '-';
  switch (kind) {
    case 'task': return 'task:' + (e.taskId || '-');
    case 'agent': return 'agent:' + agent;
    case 'model': return 'model:' + agent;
    case 'tool': return 'tool:' + agent + ':' + (d.tool || '-');
    case 'approval': return 'approval:' + (d.id || d.tool || agent);
    default: return kind + ':' + (e.taskId || '-');
  }
}

// What the row says. Plain English for the structural steps, and for a model
// call the model itself — which is the one thing a reader of a routed run
// actually wants to know.
function labelOf(kind, e) {
  const d = e.data || {};
  switch (kind) {
    case 'task': return 'the whole task';
    case 'agent': return 'agent ' + (d.role || d.profile || shortId(e.agentId || d.agentId));
    case 'model': return OH.modelOf(d) || 'a model';
    case 'tool': return d.tool || 'a tool';
    case 'approval': return 'your approval' + (d.tool ? ' for ' + d.tool : '');
    case 'evaluation': return 'checking' + (d.evaluator ? ' · ' + d.evaluator : '');
    case 'repair': return 'retrying after a failure';
    default: return kind;
  }
}

function shortId(id) {
  return id ? String(id).slice(0, 8) : '?';
}

function timeOf(e) {
  const t = e.time ? Date.parse(e.time) : NaN;
  return isNaN(t) ? Date.now() : t;
}

function ingest(e) {
  const at = timeOf(e);
  if (!state.t0 || at < state.t0) state.t0 = at;

  const rule = OPENERS[e.type];
  if (rule) {
    const key = keyOf(rule.kind, e);
    // agent.created then agent.started are two openers for one step; the first
    // wins, so the bar covers the whole life of the agent rather than
    // restarting partway through it.
    if (!state.open.has(key)) {
      const step = {
        key, kind: rule.kind, depth: rule.depth,
        label: labelOf(rule.kind, e),
        agentId: e.agentId || (e.data || {}).agentId || '',
        agentLabel: rule.kind === 'agent' ? labelOf('agent', e) : '',
        nodeLabel: labelOf(rule.kind, e),
        start: at, end: 0, tone: 'live', opener: e, closer: null,
      };
      state.open.set(key, step);
      state.steps.push(step);
      if (route) route.open(step);
    }
    return;
  }

  const kind = CLOSERS[e.type];
  if (!kind) return;
  const step = state.open.get(keyOf(kind, e));
  if (!step) return;   // a closer with no opener: nothing to attribute it to
  step.end = at;
  step.closer = e;
  step.tone = OH.toneOf(e.type) === 'bad' ? 'bad' : (kind === 'approval' ? 'warn' : 'ok');
  // A model step opens on model.requested, which knows only the alias that was
  // asked for. The model that actually answered arrives with the answer, so
  // the row is relabelled once it is known rather than left reading
  // "auto/best-coding" for a call that ran somewhere else entirely.
  if (kind === 'model') {
    const resolved = OH.modelOf(e.data || {});
    if (resolved) { step.label = resolved; step.nodeLabel = resolved; }
  }
  state.open.delete(step.key);
  if (route) route.close(step);
}

// ── Timeline ─────────────────────────────────────────────────────────────

function niceStep(total) {
  const steps = [100, 250, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000];
  for (const s of steps) if (total / s <= 6) return s;
  return 900000;
}

function renderTimeline() {
  const body = $('tl');
  const empty = $('top-empty');
  if (state.steps.length === 0) {
    empty.hidden = false;
    body.innerHTML = '';
    $('top-note').textContent = '';
    return;
  }
  empty.hidden = true;

  const now = state.replay ? 0 : Date.now();
  let t1 = state.t0;
  for (const s of state.steps) t1 = Math.max(t1, s.end || now || s.start);
  const total = Math.max(1, t1 - state.t0);

  body.innerHTML = '';

  // The axis first, so it is painted under the bars: a grid line crossing a
  // bar reads as part of the bar.
  const grid = document.createElement('div');
  grid.className = 'tl-grid';
  const inner = document.createElement('div');
  inner.className = 'tl-grid-inner';
  const step = niceStep(total);
  for (let t = 0; t <= total; t += step) {
    const tick = document.createElement('div');
    tick.className = 'tl-tick';
    tick.style.left = (100 * t / total) + '%';
    const label = document.createElement('span');
    label.textContent = OH.fmtMillis(t);
    tick.append(label);
    inner.append(tick);
  }
  grid.append(inner);
  body.append(grid);

  for (const s of state.steps) {
    const row = document.createElement('div');
    row.className = 'tl-row' + (state.selected === s ? ' sel' : '');

    const name = document.createElement('div');
    name.className = 'tl-name';
    if (s.depth > 0) {
      const indent = document.createElement('span');
      indent.className = 'tl-depth';
      indent.textContent = '│ '.repeat(s.depth);
      name.append(indent);
    }
    const what = document.createElement('span');
    what.className = 'tl-what';
    what.textContent = s.label;
    what.title = s.label;
    name.append(what);

    const track = document.createElement('div');
    track.className = 'tl-track';
    const end = s.end || now || s.start;
    const bar = document.createElement('div');
    bar.className = 'tl-bar ' + s.tone + (state.selected === s ? ' sel' : '');
    const left = 100 * (s.start - state.t0) / total;
    const width = Math.max(0.4, 100 * (end - s.start) / total);
    bar.style.left = left + '%';
    bar.style.width = Math.min(width, 100 - left) + '%';
    bar.title = s.label + ' · ' + OH.fmtMillis(end - s.start);
    bar.onclick = () => select(s);

    const dur = document.createElement('div');
    dur.className = 'tl-dur';
    dur.style.left = Math.min(left + width, 99) + '%';
    dur.textContent = OH.fmtMillis(end - s.start);

    track.append(bar, dur);
    row.append(name, track);
    body.append(row);
  }

  const live = state.open.size;
  $('top-note').textContent = state.steps.length + ' steps · ' + OH.fmtMillis(total) +
    (live && !state.replay ? ' · ' + live + ' running' : '');
}

// ── Event log ────────────────────────────────────────────────────────────

function matchesFilter(e) {
  if (!state.filter) return true;
  const q = state.filter;
  return e.type.includes(q) ||
    OH.phraseOf(e.type).toLowerCase().includes(q) ||
    OH.summarise(e).toLowerCase().includes(q);
}

function renderEvents() {
  const body = $('log-body');
  const shown = state.events.filter(matchesFilter);
  $('log-empty').hidden = shown.length > 0;
  for (const stale of body.querySelectorAll('.ev')) stale.remove();

  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  for (const e of shown.slice(-600)) {
    const row = document.createElement('div');
    const fresh = !state.replay && e.id && !state.seen.has(e.id);
    if (e.id) state.seen.add(e.id);
    row.className = 'ev ' + OH.toneOf(e.type) + (state.selected === e ? ' sel' : '') + (fresh ? ' fresh' : '');
    for (const [cls, text] of [
      ['ev-t', OH.clockOf(e)],
      ['ev-s', OH.stateOf(e.type)],
      ['ev-w', OH.phraseOf(e.type)],
      ['ev-d', OH.summarise(e)],
      ['ev-k', e.type],
    ]) {
      const cell = document.createElement('span');
      cell.className = cls;
      cell.textContent = text;
      row.append(cell);
    }
    row.onclick = () => select(e);
    body.append(row);
  }
  $('log-note').textContent = state.filter
    ? shown.length + ' of ' + state.events.length
    : (state.events.length ? String(state.events.length) : '');
  // Follow the tail only if the reader was already at it. Yanking the view
  // back while someone is reading an earlier event is the worst habit a live
  // log can have.
  if (atBottom) body.scrollTop = body.scrollHeight;
}

// ── Details ──────────────────────────────────────────────────────────────

// A small JSON pretty-printer. Colouring by token type is the difference
// between reading a payload and searching one; a library for it would be a
// network dependency this binary refuses to have.
function renderJSON(value, indent) {
  const pad = '  '.repeat(indent);
  const padInner = '  '.repeat(indent + 1);
  if (value === null) return tag('b', 'null');
  if (Array.isArray(value)) {
    if (value.length === 0) return document.createTextNode('[]');
    const frag = document.createDocumentFragment();
    frag.append('[\n');
    value.forEach((item, i) => {
      frag.append(padInner);
      frag.append(renderJSON(item, indent + 1));
      frag.append(i < value.length - 1 ? ',\n' : '\n');
    });
    frag.append(pad + ']');
    return frag;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return document.createTextNode('{}');
    const frag = document.createDocumentFragment();
    frag.append('{\n');
    keys.forEach((k, i) => {
      frag.append(padInner);
      frag.append(tag('key', JSON.stringify(k)));
      frag.append(': ');
      frag.append(renderJSON(value[k], indent + 1));
      frag.append(i < keys.length - 1 ? ',\n' : '\n');
    });
    frag.append(pad + '}');
    return frag;
  }
  if (typeof value === 'number') return tag('n', String(value));
  if (typeof value === 'boolean') return tag('b', String(value));
  return tag('s', JSON.stringify(value));
}

function tag(cls, text) {
  const el = document.createElement('span');
  el.className = cls;
  el.textContent = text;
  return el;
}

function select(what) {
  state.selected = what;
  renderDetails();
  renderEvents();
  renderTimeline();
}

function renderDetails() {
  const body = $('det-body');
  body.innerHTML = '';
  const sel = state.selected;
  if (!sel) {
    body.append(tag('det-empty',
      'Pick a row in the timeline or the event log to see everything the harness recorded about it — the model that answered, how long it took, and the full payload.'));
    return;
  }

  const isStep = Boolean(sel.opener);
  const e = isStep ? sel.opener : sel;
  const d = e.data || {};

  body.append(tag('det-k', isStep ? sel.label : OH.phraseOf(e.type)));
  body.append(tag('det-sub', isStep
    ? e.type + (sel.closer ? ' → ' + sel.closer.type : ' · still running')
    : e.type + ' · ' + OH.clockOf(e)));

  const rows = [];
  if (isStep) {
    rows.push(['took', OH.fmtMillis((sel.end || (state.replay ? sel.start : Date.now())) - sel.start), true]);
    rows.push(['started', new Date(sel.start).toTimeString().slice(0, 8)]);
    if (sel.end) rows.push(['ended', new Date(sel.end).toTimeString().slice(0, 8)]);
  }

  // The facts a reader of a routed run wants, spelled out rather than left in
  // the raw payload: what was asked for, what answered, what it cost.
  const closerData = (sel.closer && sel.closer.data) || {};
  const asked = d.model || closerData.model;
  const answered = closerData.resolvedModel || d.resolvedModel;
  if (answered) {
    rows.push(['model that answered', answered, true]);
    if (asked && asked !== answered) rows.push(['asked for', asked]);
  } else if (asked) {
    rows.push(['model', asked, true]);
  }
  const usage = closerData.tokensIn !== undefined ? closerData : d;
  if (usage.tokensIn || usage.tokensOut) {
    rows.push(['tokens', (usage.tokensIn || 0) + ' in · ' + (usage.tokensOut || 0) + ' out']);
  }
  if (usage.costUsd) rows.push(['cost (estimated)', OH.fmtCost(usage.costUsd)]);
  if (typeof usage.latency === 'number') rows.push(['gateway latency', OH.fmtNanos(usage.latency)]);
  if (e.taskId) rows.push(['task', e.taskId]);
  if (e.agentId) rows.push(['agent', e.agentId]);

  if (rows.length) {
    const dl = document.createElement('dl');
    dl.className = 'kv';
    for (const [k, v, big] of rows) {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      if (big) dd.className = 'big';
      dl.append(dt, dd);
    }
    body.append(dl);
  }

  body.append(tag('det-sub', isStep ? e.type : 'payload'));
  const pre = document.createElement('div');
  pre.className = 'payload';
  pre.append(renderJSON(e.data === undefined ? null : e.data, 0));
  body.append(pre);

  if (isStep && sel.closer && sel.closer.data) {
    body.append(tag('det-sub', sel.closer.type));
    const closed = document.createElement('div');
    closed.className = 'payload';
    closed.append(renderJSON(sel.closer.data, 0));
    body.append(closed);
  }
}

// ── Title bar ────────────────────────────────────────────────────────────

function setState(word, tone, what) {
  const el = $('state');
  el.className = 'state ' + (tone || '');
  el.textContent = word;
  const ticks = document.createElement('span');
  ticks.className = 'ticks';
  el.append(ticks);
  if (what !== undefined) $('what').textContent = what;
  // The window title is the taskbar entry and the alt-tab label; putting the
  // run state in it is a large part of why this is a window and not a tab.
  document.title = state.running ? 'omniharness · running' : 'omniharness';
}

function tick() {
  if (!state.running) return;
  $('elapsed').textContent = OH.fmtMillis(Date.now() - state.runStart);
  renderTimeline();
  if (state.selected && state.selected.opener) renderDetails();
}

// ── Approvals ────────────────────────────────────────────────────────────

function renderApprovals() {
  const box = $('approvals');
  box.innerHTML = '';
  for (const a of state.approvals) {
    const card = document.createElement('div');
    card.className = 'approval';

    const top = document.createElement('div');
    top.className = 'approval-top';
    top.append(tag('approval-tool', a.tool || 'this task'),
      tag('approval-risk', (a.risk || 'unknown') + ' risk'));

    const actions = document.createElement('div');
    actions.className = 'approval-actions';
    const deny = document.createElement('button');
    deny.className = 'deny';
    deny.textContent = 'deny';
    deny.onclick = () => answer(a.id, false);
    const grant = document.createElement('button');
    grant.className = 'grant';
    grant.textContent = 'approve';
    grant.onclick = () => answer(a.id, true);
    // Deny first, so approve is never the button under the cursor by accident.
    actions.append(deny, grant);

    card.append(top, tag('approval-why', a.reason || 'waiting for your decision'), actions);
    box.append(card);
  }
}

async function answer(id, granted) {
  await OH.answerApproval(id, granted);
  await refreshApprovals();
}

async function refreshApprovals() {
  try {
    state.approvals = await OH.approvals();
    renderApprovals();
    for (const a of state.approvals) {
      if (!state.notified.has(a.id)) {
        state.notified.add(a.id);
        notify('approval needed', (a.tool || 'a step') + ' — ' + (a.reason || 'waiting for your decision'));
      }
    }
  } catch (_) { /* the stream brings it round again */ }
}

// ── Notifications ────────────────────────────────────────────────────────
//
// A run takes minutes and blocks on approvals. Without this the window has to
// be watched, which defeats the point of it being a window: the user moves to
// another app and the harness waits, silently, for a decision nobody knows is
// pending. Permission is asked on the first run — a real gesture — rather than
// on load, because a page that asks the moment it opens gets denied.
function notify(title, body) {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  if (document.hasFocus() && document.visibilityState === 'visible' && title !== 'approval needed') return;
  try { new Notification(title, { body }); } catch (_) { /* not fatal */ }
}

function askToNotify() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') Notification.requestPermission();
}

// ── Sessions, past and present ───────────────────────────────────────────

let sessionList = [];

function sessionName(s) {
  return s.title || s.name || s.id;
}

async function refreshSessions() {
  try {
    sessionList = (await OH.sessions()).slice(0, 60);
    const box = $('sessions');
    box.innerHTML = '';
    if (sessionList.length === 0) {
      box.append(tag('sessions-empty', 'none yet'));
      return;
    }
    const activeId = state.replay ? state.replay.id : state.sessionId;
    for (const s of sessionList) {
      const item = document.createElement('button');
      item.className = 'session' + (s.id === activeId ? ' active' : '');
      item.textContent = sessionName(s);
      item.title = item.textContent;
      item.onclick = () => openSession(s);
      box.append(item);
    }
  } catch (_) { /* the rail is not worth an error banner */ }
}

// openSession reads a stored session and draws it. Clicking a row used to only
// set the id used by the next run, which looked like navigation and showed
// nothing — the complaint that "I can't actually see what happened in past
// sessions" was exactly right.
async function openSession(s) {
  if (state.running) return;
  state.replay = { id: s.id, name: sessionName(s) };
  state.sessionId = s.id;
  reset();
  $('replay').hidden = false;
  $('replay-name').textContent = sessionName(s);
  setState('reading', '', sessionName(s));
  $('elapsed').textContent = '';
  refreshSessions();

  try {
    const events = await OH.sessionEvents(s.id, 4000);
    for (const e of events) {
      state.events.push(e);
      if (e.id) state.seen.add(e.id);
      ingest(e);
    }
    // Anything still open at the end of a stored session never got a closer —
    // the process died, or the run was abandoned. Showing those bars growing
    // against the current clock would be a lie about a session that ended
    // hours ago, so they are pinned to the last event instead.
    const last = state.events.length ? timeOf(state.events[state.events.length - 1]) : 0;
    for (const step of state.open.values()) {
      step.end = last || step.start;
      step.tone = 'bad';
    }
    state.open.clear();
    renderEvents();
    renderTimeline();
    $('log-note').textContent = String(state.events.length);
  } catch (_) {
    $('log-note').textContent = 'could not read that session';
  }
}

function exitReplay() {
  state.replay = null;
  state.sessionId = '';
  $('replay').hidden = true;
  reset();
  setState('idle', '', 'nothing running');
  $('elapsed').textContent = '';
  refreshSessions();
  $('prompt').focus();
}

// ── Running ──────────────────────────────────────────────────────────────

function reset() {
  state.events = [];
  state.steps = [];
  state.open.clear();
  state.t0 = 0;
  state.selected = null;
  if (route) route.clear();
  renderEvents();
  renderTimeline();
  renderDetails();
}

async function submit() {
  const prompt = $('prompt').value.trim();
  if (!prompt || state.running) return;
  askToNotify();
  const sessionId = state.replay ? '' : state.sessionId;
  state.replay = null;
  $('replay').hidden = true;
  state.running = true;
  state.runStart = Date.now();
  reset();
  $('go').disabled = true;
  $('cancel').hidden = false;
  $('prompt').value = '';
  autosize();
  state.label = prompt;
  setState('running', 'running', prompt);

  try {
    const body = await OH.run(prompt, sessionId);
    state.sessionId = body.sessionId || state.sessionId;
    const status = (body.task && body.task.status) || (body.error ? 'failed' : 'unknown');
    const ok = status === 'completed';
    state.running = false;
    setState(ok ? 'done' : 'failed', ok ? 'done' : 'failed', body.error ? String(body.error).slice(0, 160) : prompt);
    $('elapsed').textContent = OH.fmtMillis(Date.now() - state.runStart);
    notify(ok ? 'run finished' : 'run failed', prompt);
  } catch (_) {
    state.running = false;
    setState('failed', 'failed', 'the server did not answer');
    notify('run failed', 'the server did not answer');
  } finally {
    state.running = false;
    state.taskId = '';
    $('go').disabled = false;
    $('cancel').hidden = true;
    // Close anything the run left open, so a bar does not keep growing after
    // the run that owned it has ended.
    const now = Date.now();
    for (const s of state.open.values()) { s.end = now; s.tone = 'bad'; }
    state.open.clear();
    renderTimeline();
    renderDetails();
    refreshApprovals();
    refreshSessions();
  }
}

async function cancelRun() {
  if (!state.taskId) return;
  await OH.cancelTask(state.taskId);
}

async function health() {
  try {
    const h = await OH.health();
    $('version').textContent = (h.version || '').replace(/^omniharness /, 'v').replace(/ .*/, '');
    $('gw').textContent = h.omniroute ? 'connected' : 'unreachable';
    $('gw-dot').className = 'dot ' + (h.omniroute ? 'ok' : 'bad');
  } catch (_) {
    $('gw').textContent = 'no server';
    $('gw-dot').className = 'dot bad';
  }
}

function autosize() {
  const el = $('prompt');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 170) + 'px';
}

// ── Panes that stay where you put them ───────────────────────────────────

const LAYOUT_KEY = 'oh.desktop.layout';

function loadLayout() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}'); } catch (_) { /* first run */ }
  if (saved.rail) $('rail').style.width = saved.rail + 'px';
  if (saved.det) $('details').style.width = saved.det + 'px';
  if (saved.top) $('top').style.height = saved.top + 'px';
  if (saved.detHidden) $('details').hidden = true;
  if (saved.topHidden) $('top').hidden = true;
  if (saved.tab === 'route') showTab('route');
}

function saveLayout() {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({
      rail: $('rail').offsetWidth,
      det: $('details').hidden ? 0 : $('details').offsetWidth,
      top: $('top').hidden ? 0 : $('top').offsetHeight,
      detHidden: $('details').hidden,
      topHidden: $('top').hidden,
      tab: $('route').hidden ? 'timeline' : 'route',
    }));
  } catch (_) { /* private mode: the layout is simply not remembered */ }
}

// dragger wires one splitter. `sign` is which way the pane grows relative to
// the pointer: the details pane is on the right, so it widens as the pointer
// moves left.
function dragger(handleId, paneId, axis, sign, min, max) {
  const handle = $(handleId);
  const pane = $(paneId);
  handle.addEventListener('pointerdown', (down) => {
    down.preventDefault();
    handle.setPointerCapture(down.pointerId);
    handle.classList.add('dragging');
    document.body.classList.add(axis === 'x' ? 'resizing' : 'resizing-v');
    const start = axis === 'x' ? down.clientX : down.clientY;
    const from = axis === 'x' ? pane.offsetWidth : pane.offsetHeight;

    const move = (e) => {
      const at = axis === 'x' ? e.clientX : e.clientY;
      const next = Math.min(max, Math.max(min, from + sign * (at - start)));
      if (axis === 'x') pane.style.width = next + 'px';
      else { pane.style.height = next + 'px'; renderTimeline(); }
    };
    const up = () => {
      handle.classList.remove('dragging');
      document.body.classList.remove('resizing', 'resizing-v');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      saveLayout();
      renderTimeline();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

function showTab(which) {
  const onRoute = which === 'route';
  $('route').hidden = !onRoute;
  $('tl').hidden = onRoute;
  $('tab-route').classList.toggle('on', onRoute);
  $('tab-timeline').classList.toggle('on', !onRoute);
  $('top-empty').hidden = onRoute ? (route ? route.count() > 0 : true) : state.steps.length > 0;
  if (!onRoute) renderTimeline();
}

// ── Command palette ──────────────────────────────────────────────────────

let palItems = [];
let palIndex = 0;

function commands() {
  const list = [
    { kind: 'run', text: 'new run', go: newRun },
    { kind: 'run', text: 'stop the running task', go: cancelRun },
    { kind: 'view', text: 'show the timeline', go: () => { showTab('timeline'); saveLayout(); } },
    { kind: 'view', text: 'show the route graph', go: () => { showTab('route'); saveLayout(); } },
    {
      kind: 'view', text: ($('details').hidden ? 'show' : 'hide') + ' the details pane',
      go: () => { $('details').hidden = !$('details').hidden; $('split-det').hidden = $('details').hidden; saveLayout(); },
    },
    {
      kind: 'view', text: ($('top').hidden ? 'show' : 'hide') + ' the timeline pane',
      go: () => { $('top').hidden = !$('top').hidden; $('split-top').hidden = $('top').hidden; saveLayout(); renderTimeline(); },
    },
    { kind: 'view', text: 'clear the event log', go: reset },
    { kind: 'view', text: 'open the web view', go: () => { window.location.href = '/'; } },
  ];
  if (state.replay) list.unshift({ kind: 'run', text: 'back to live', go: exitReplay });
  for (const s of sessionList) {
    list.push({ kind: 'session', text: sessionName(s), go: () => openSession(s) });
  }
  return list;
}

function openPalette() {
  $('pal-scrim').hidden = false;
  $('pal-input').value = '';
  palIndex = 0;
  renderPalette();
  $('pal-input').focus();
}

function closePalette() {
  $('pal-scrim').hidden = true;
  $('prompt').focus();
}

function renderPalette() {
  const q = $('pal-input').value.trim().toLowerCase();
  palItems = commands().filter((c) => !q || c.text.toLowerCase().includes(q) || c.kind.includes(q));
  if (palIndex >= palItems.length) palIndex = Math.max(0, palItems.length - 1);
  const list = $('pal-list');
  list.innerHTML = '';
  if (palItems.length === 0) {
    list.append(tag('pal-empty', 'nothing matches'));
    return;
  }
  palItems.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'pal-item' + (i === palIndex ? ' on' : '');
    row.append(tag('pal-kind', c.kind), tag('pal-text', c.text));
    if (i === palIndex) {
      const hint = document.createElement('kbd');
      hint.className = 'pal-hint';
      hint.textContent = 'enter';
      row.append(hint);
    }
    row.onmouseenter = () => { palIndex = i; renderPalette(); };
    row.onclick = () => { closePalette(); c.go(); };
    list.append(row);
  });
}

function newRun() {
  state.replay = null;
  state.sessionId = '';
  $('replay').hidden = true;
  reset();
  setState('idle', '', 'nothing running');
  $('elapsed').textContent = '';
  refreshSessions();
  $('prompt').focus();
}

// ── Boot ─────────────────────────────────────────────────────────────────

function boot() {
  route = createRoute($('route-canvas'), $('route-labels'));
  if (route) {
    let last = performance.now();
    const spin = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      // Only while the pane is on screen: a hidden canvas has no business
      // burning a frame budget.
      if (!$('route').hidden) route.frame(dt);
      requestAnimationFrame(spin);
    };
    requestAnimationFrame(spin);
  }

  loadLayout();
  $('split-det').hidden = $('details').hidden;
  $('split-top').hidden = $('top').hidden;

  dragger('split-rail', 'rail', 'x', 1, 180, 440);
  dragger('split-det', 'details', 'x', -1, 260, 640);
  dragger('split-top', 'top', 'y', 1, 110, 660);

  $('go').onclick = submit;
  $('cancel').onclick = cancelRun;
  $('new-run').onclick = newRun;
  $('pal-open').onclick = openPalette;
  $('replay-exit').onclick = exitReplay;
  $('tab-timeline').onclick = () => { showTab('timeline'); saveLayout(); };
  $('tab-route').onclick = () => { showTab('route'); saveLayout(); };
  $('pal-scrim').onclick = (e) => { if (e.target === $('pal-scrim')) closePalette(); };
  $('pal-input').addEventListener('input', () => { palIndex = 0; renderPalette(); });
  $('filter').addEventListener('input', () => {
    state.filter = $('filter').value.trim().toLowerCase();
    renderEvents();
  });

  $('prompt').addEventListener('input', autosize);
  $('prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  });

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if ($('pal-scrim').hidden) openPalette(); else closePalette();
      return;
    }
    if (!$('pal-scrim').hidden) {
      if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); palIndex = Math.min(palItems.length - 1, palIndex + 1); renderPalette(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); palIndex = Math.max(0, palIndex - 1); renderPalette(); }
      if (e.key === 'Enter') {
        e.preventDefault();
        const c = palItems[palIndex];
        closePalette();
        if (c) c.go();
      }
      return;
    }
    // A pending approval is the one thing worth a bare key, and only while the
    // composer does not hold the caret.
    if (state.approvals.length && document.activeElement !== $('prompt')) {
      if (e.key === 'y') { e.preventDefault(); answer(state.approvals[0].id, true); }
      if (e.key === 'n') { e.preventDefault(); answer(state.approvals[0].id, false); }
    }
    if (e.key === 'Escape' && state.selected) { state.selected = null; renderDetails(); renderEvents(); renderTimeline(); }
  });

  window.addEventListener('resize', renderTimeline);

  health();
  refreshApprovals();
  refreshSessions();
  OH.connect({
    onLink: (status) => { $('link').textContent = status; },
    onGap: (total) => {
      $('gaps').hidden = false;
      $('gaps').textContent = total + ' events dropped — this client fell behind';
    },
    onEvent: (e) => {
      // A live event while reading history means a run started elsewhere. The
      // history stays put rather than being overwritten mid-read.
      if (state.replay) return;
      if (e.taskId) state.taskId = e.taskId;
      if (e.type.startsWith('approval.')) refreshApprovals();

      // A run can start somewhere other than this composer — the API, the TUI,
      // another window on the same server. The stream filled the timeline for
      // those, but the title bar went on saying "idle / nothing running" while
      // work was visibly happening a few pixels below it.
      if (e.type === 'task.started' && !state.running) {
        state.running = true;
        state.runStart = timeOf(e);
        // task.started's own summary is the status line "task started"; the
        // prompt came with task.created a moment earlier, and it is what the
        // reader actually wants in the title bar.
        setState('running', 'running', state.label || 'a run started elsewhere');
      } else if (state.running && (e.type === 'task.completed' || e.type === 'task.failed' || e.type === 'task.cancelled')) {
        const ok = e.type === 'task.completed';
        state.running = false;
        setState(ok ? 'done' : 'failed', ok ? 'done' : 'failed', $('what').textContent);
        $('elapsed').textContent = OH.fmtMillis(timeOf(e) - state.runStart);
      }
      // task.created carries the prompt, which is a better label than the
      // status line task.started ships with.
      if (e.type === 'task.created' && (e.data || {}).prompt) {
        state.label = e.data.prompt;
        $('what').textContent = e.data.prompt;
      }
      state.events.push(e);
      ingest(e);
      renderEvents();
      renderTimeline();
      if (state.selected && state.selected.opener) renderDetails();
    },
  });

  setInterval(health, 15000);
  setInterval(tick, 250);
  $('prompt').focus();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
