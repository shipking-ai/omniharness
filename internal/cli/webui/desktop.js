// The desktop shell.
//
// The web view renders the event stream as a scrollback, which is the right
// shape for a tab. A window has room for the question a scrollback cannot
// answer — where did the run actually spend its time, and what was happening
// concurrently — so this surface pairs the log with a waterfall built from the
// same events, and an inspector that shows the payload the log line summarises.
//
// Everything that talks to the harness is in core.js.

const $ = (id) => document.getElementById(id);

const state = {
  events: [],
  approvals: [],
  spans: [],              // in the order they opened
  open: new Map(),        // key -> span, while it is still running
  t0: 0,                  // first span start, epoch ms
  taskId: '',
  sessionId: '',
  running: false,
  runStart: 0,
  selected: null,         // an event, or a span
  filter: '',
  notified: new Set(),    // approval ids already announced
};

// ── Spans ────────────────────────────────────────────────────────────────
//
// A span is an opener event and the closer that answers it. The pairing is
// declared rather than inferred: guessing from name shape would silently pair
// `agent.updated` with `agent.completed` and report a duration that is really
// the gap between two progress reports.
const SPAN_RULES = {
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

// keyOf identifies the thing a span is about, so an opener and its closer land
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

function labelOf(kind, e) {
  const d = e.data || {};
  switch (kind) {
    case 'task': return 'task';
    case 'agent': return 'agent ' + (d.role || d.profile || shortId(e.agentId || d.agentId));
    case 'model': return d.model || 'model';
    case 'tool': return d.tool || 'tool';
    case 'approval': return 'approval ' + (d.tool || '');
    case 'evaluation': return 'evaluate ' + (d.evaluator || '');
    case 'repair': return 'repair';
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

function ingestSpan(e) {
  const at = timeOf(e);
  if (!state.t0 || at < state.t0) state.t0 = at;

  const rule = SPAN_RULES[e.type];
  if (rule) {
    const key = keyOf(rule.kind, e);
    // agent.created then agent.started are two openers for one span; the first
    // wins so the bar covers the whole life of the agent rather than restarting.
    if (!state.open.has(key)) {
      const span = {
        key: key, kind: rule.kind, depth: rule.depth,
        label: labelOf(rule.kind, e), start: at, end: 0,
        tone: 'live', opener: e, closer: null,
      };
      state.open.set(key, span);
      state.spans.push(span);
    }
    return;
  }

  const kind = CLOSERS[e.type];
  if (!kind) return;
  const key = keyOf(kind, e);
  const span = state.open.get(key);
  if (!span) return;   // a closer with no opener: nothing to attribute it to
  span.end = at;
  span.closer = e;
  span.tone = OH.toneOf(e.type) === 'bad' ? 'bad' : (kind === 'approval' ? 'warn' : 'ok');
  state.open.delete(key);
}

// ── Waterfall ────────────────────────────────────────────────────────────

function niceStep(span) {
  const steps = [100, 250, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000];
  for (const s of steps) if (span / s <= 6) return s;
  return 900000;
}

function fmtDur(ms) {
  if (ms < 1000) return Math.round(ms) + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's';
  const m = Math.floor(ms / 60000);
  return m + 'm' + String(Math.round((ms % 60000) / 1000)).padStart(2, '0') + 's';
}

function renderWaterfall() {
  const body = $('wf-body');
  const empty = $('wf-empty');
  if (state.spans.length === 0) {
    empty.hidden = false;
    body.hidden = true;
    body.innerHTML = '';
    $('wf-note').textContent = '';
    return;
  }
  empty.hidden = true;
  body.hidden = false;

  const now = Date.now();
  let t1 = state.t0;
  for (const s of state.spans) t1 = Math.max(t1, s.end || now);
  const total = Math.max(1, t1 - state.t0);

  body.innerHTML = '';

  // The axis first, so it is painted under the bars.
  const grid = document.createElement('div');
  grid.className = 'wf-grid';
  const inner = document.createElement('div');
  inner.className = 'wf-grid-inner';
  const step = niceStep(total);
  for (let t = 0; t <= total; t += step) {
    const tick = document.createElement('div');
    tick.className = 'wf-tick';
    tick.style.left = (100 * t / total) + '%';
    const label = document.createElement('span');
    label.textContent = fmtDur(t);
    tick.append(label);
    inner.append(tick);
  }
  grid.append(inner);
  body.append(grid);

  for (const s of state.spans) {
    const row = document.createElement('div');
    row.className = 'wf-row';

    const name = document.createElement('div');
    name.className = 'wf-name';
    if (s.depth > 0) {
      const indent = document.createElement('span');
      indent.className = 'depth';
      indent.textContent = '·'.repeat(s.depth) + ' ';
      name.append(indent);
    }
    name.append(document.createTextNode(s.label));
    name.title = s.label;

    const track = document.createElement('div');
    track.className = 'wf-track';
    const end = s.end || now;
    const bar = document.createElement('div');
    bar.className = 'wf-bar ' + s.tone + (state.selected === s ? ' sel' : '');
    const left = 100 * (s.start - state.t0) / total;
    const width = Math.max(0.4, 100 * (end - s.start) / total);
    bar.style.left = left + '%';
    bar.style.width = Math.min(width, 100 - left) + '%';
    bar.title = s.label + ' · ' + fmtDur(end - s.start);
    bar.onclick = () => select(s);

    const dur = document.createElement('div');
    dur.className = 'wf-dur';
    dur.style.left = Math.min(left + width, 99) + '%';
    dur.textContent = fmtDur(end - s.start);

    track.append(bar, dur);
    row.append(name, track);
    body.append(row);
  }

  const live = state.open.size;
  $('wf-note').textContent = state.spans.length + ' spans · ' + fmtDur(total) +
    (live ? ' · ' + live + ' live' : '');
}

// ── Event log ────────────────────────────────────────────────────────────

function matchesFilter(e) {
  if (!state.filter) return true;
  const q = state.filter;
  return e.type.includes(q) || OH.summarise(e).toLowerCase().includes(q);
}

function renderEvents() {
  const body = $('log-body');
  const shown = state.events.filter(matchesFilter);
  $('log-empty').hidden = shown.length > 0;
  for (const stale of body.querySelectorAll('.ev')) stale.remove();

  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  for (const e of shown.slice(-500)) {
    const row = document.createElement('div');
    row.className = 'ev ' + OH.toneOf(e.type) + (state.selected === e ? ' sel' : '');
    for (const [cls, text] of [
      ['ev-t', OH.clockOf(e)],
      ['ev-m', OH.markOf(e.type)],
      ['ev-k', e.type],
      ['ev-d', OH.summarise(e)],
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
  // Follow the tail only if the reader was already at it; yanking the view
  // back while someone is reading an earlier event is the worst habit a live
  // log can have.
  if (atBottom) body.scrollTop = body.scrollHeight;
}

// ── Inspector ────────────────────────────────────────────────────────────

// A tiny JSON pretty-printer. Colouring by token type is the difference
// between reading a payload and searching one; a library for it would be a
// network dependency this binary refuses to have.
function renderJSON(value, indent) {
  const pad = '  '.repeat(indent);
  const padInner = '  '.repeat(indent + 1);
  if (value === null) return span('b', 'null');
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
      frag.append(span('key', JSON.stringify(k)));
      frag.append(': ');
      frag.append(renderJSON(value[k], indent + 1));
      frag.append(i < keys.length - 1 ? ',\n' : '\n');
    });
    frag.append(pad + '}');
    return frag;
  }
  if (typeof value === 'number') return span('n', String(value));
  if (typeof value === 'boolean') return span('b', String(value));
  return span('s', JSON.stringify(value));
}

function span(cls, text) {
  const el = document.createElement('span');
  el.className = cls;
  el.textContent = text;
  return el;
}

function select(what) {
  state.selected = what;
  renderInspector();
  renderEvents();
  renderWaterfall();
}

function renderInspector() {
  const body = $('insp-body');
  body.innerHTML = '';
  const sel = state.selected;
  if (!sel) {
    body.append(span('insp-empty', 'select an event or a span to see its payload'));
    return;
  }

  // A span is shown through its opener, with the timing the pair proves.
  const e = sel.opener || sel;
  const isSpan = Boolean(sel.opener);

  body.append(span('insp-k', isSpan ? sel.label : e.type));
  body.append(span('insp-sub', isSpan ? e.type + (sel.closer ? ' → ' + sel.closer.type : ' · still running') : OH.clockOf(e)));

  const rows = [];
  if (isSpan) {
    rows.push(['duration', fmtDur((sel.end || Date.now()) - sel.start)]);
    rows.push(['started', new Date(sel.start).toTimeString().slice(0, 8)]);
    if (sel.end) rows.push(['ended', new Date(sel.end).toTimeString().slice(0, 8)]);
  }
  if (e.taskId) rows.push(['task', e.taskId]);
  if (e.agentId) rows.push(['agent', e.agentId]);
  if (e.sessionId) rows.push(['session', e.sessionId]);

  if (rows.length) {
    const dl = document.createElement('dl');
    dl.className = 'kv';
    for (const [k, v] of rows) {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      dl.append(dt, dd);
    }
    body.append(dl);
  }

  const pre = document.createElement('div');
  pre.className = 'payload';
  pre.append(renderJSON(e.data === undefined ? null : e.data, 0));
  body.append(pre);

  if (isSpan && sel.closer && sel.closer.data) {
    body.append(span('insp-sub', sel.closer.type));
    const closed = document.createElement('div');
    closed.className = 'payload';
    closed.append(renderJSON(sel.closer.data, 0));
    body.append(closed);
  }
}

// ── Title bar ────────────────────────────────────────────────────────────

function setRun(title, mark, tone) {
  $('tb-title').textContent = title;
  const el = $('tb-mark');
  el.textContent = mark;
  el.className = 'tb-mark ' + (tone || '');
  // The window title is the taskbar entry and the alt-tab label. Putting the
  // run state in it is the whole reason to be a window rather than a tab.
  document.title = state.running ? 'omniharness · running' : 'omniharness';
}

function tickClock() {
  if (!state.running) return;
  $('tb-time').textContent = fmtDur(Date.now() - state.runStart);
  renderWaterfall();
  if (state.selected && state.selected.opener) renderInspector();
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
    top.append(span('approval-tool', a.tool || 'this task'),
      span('approval-risk', (a.risk || 'unknown') + ' risk'));

    const why = span('approval-why', a.reason || 'waiting for your decision');

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

    card.append(top, why, actions);
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
// be watched, which defeats the point of it being a window: the user goes to
// another app and the harness waits, silently, for a decision nobody knows is
// pending. Permission is asked on the first run — a real gesture — rather than
// on load, because a page that asks the moment it opens gets denied.
function notify(title, body) {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  if (document.hasFocus() && document.visibilityState === 'visible' && title !== 'approval needed') return;
  try { new Notification(title, { body: body, silent: false }); } catch (_) { /* not fatal */ }
}

function askToNotify() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') Notification.requestPermission();
}

// ── Sessions ─────────────────────────────────────────────────────────────

let sessionList = [];

async function refreshSessions() {
  try {
    sessionList = (await OH.sessions()).slice(0, 60);
    const box = $('sessions');
    box.innerHTML = '';
    if (sessionList.length === 0) {
      box.append(span('sessions-empty', 'none yet'));
      return;
    }
    for (const s of sessionList) {
      const item = document.createElement('button');
      item.className = 'session' + (s.id === state.sessionId ? ' active' : '');
      item.textContent = s.title || s.name || s.id;
      item.title = item.textContent;
      item.onclick = () => { state.sessionId = s.id; refreshSessions(); };
      box.append(item);
    }
  } catch (_) { /* the rail is not worth an error banner */ }
}

// ── Running ──────────────────────────────────────────────────────────────

function resetRun() {
  state.events = [];
  state.spans = [];
  state.open.clear();
  state.t0 = 0;
  state.selected = null;
  renderEvents();
  renderWaterfall();
  renderInspector();
}

async function submit() {
  const prompt = $('prompt').value.trim();
  if (!prompt || state.running) return;
  askToNotify();
  state.running = true;
  state.runStart = Date.now();
  resetRun();
  $('go').disabled = true;
  $('cancel').hidden = false;
  $('prompt').value = '';
  autosize();
  setRun(prompt, '..', 'busy');

  try {
    const body = await OH.run(prompt, state.sessionId);
    state.sessionId = body.sessionId || state.sessionId;
    const status = (body.task && body.task.status) || (body.error ? 'failed' : 'unknown');
    const ok = status === 'completed';
    state.running = false;
    setRun(prompt, ok ? 'ok' : 'FAIL', ok ? 'ok' : 'bad');
    $('tb-time').textContent = fmtDur(Date.now() - state.runStart);
    notify(ok ? 'run finished' : 'run failed', prompt);
  } catch (_) {
    state.running = false;
    setRun(prompt, 'FAIL', 'bad');
    notify('run failed', 'the server did not answer');
  } finally {
    state.running = false;
    state.taskId = '';
    $('go').disabled = false;
    $('cancel').hidden = true;
    // Close any span the run left open, so a bar does not grow forever after
    // the run that owned it has ended.
    const now = Date.now();
    for (const s of state.open.values()) { s.end = now; s.tone = 'bad'; }
    state.open.clear();
    renderWaterfall();
    renderInspector();
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
  if (saved.insp) $('inspector').style.width = saved.insp + 'px';
  if (saved.wf) $('wf').style.height = saved.wf + 'px';
  if (saved.inspHidden) $('inspector').hidden = true;
  if (saved.wfHidden) $('wf').hidden = true;
}

function saveLayout() {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({
      rail: $('rail').offsetWidth,
      insp: $('inspector').hidden ? 0 : $('inspector').offsetWidth,
      wf: $('wf').hidden ? 0 : $('wf').offsetHeight,
      inspHidden: $('inspector').hidden,
      wfHidden: $('wf').hidden,
    }));
  } catch (_) { /* private mode: the layout is simply not remembered */ }
}

// dragger wires one splitter. `sign` is which way the pane grows relative to
// the pointer: the inspector is on the right, so it widens as the pointer
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
      else { pane.style.height = next + 'px'; renderWaterfall(); }
    };
    const up = () => {
      handle.classList.remove('dragging');
      document.body.classList.remove('resizing', 'resizing-v');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      saveLayout();
      renderWaterfall();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

// ── Command palette ──────────────────────────────────────────────────────

let palItems = [];
let palIndex = 0;

function commands() {
  const list = [
    { kind: 'run', text: 'new run', go: () => newRun() },
    { kind: 'run', text: 'cancel the running task', go: () => cancelRun() },
    { kind: 'view', text: ($('inspector').hidden ? 'show' : 'hide') + ' the inspector', go: () => { $('inspector').hidden = !$('inspector').hidden; $('split-insp').hidden = $('inspector').hidden; saveLayout(); } },
    { kind: 'view', text: ($('wf').hidden ? 'show' : 'hide') + ' the waterfall', go: () => { $('wf').hidden = !$('wf').hidden; $('split-wf').hidden = $('wf').hidden; saveLayout(); renderWaterfall(); } },
    { kind: 'view', text: 'clear the event log', go: () => resetRun() },
    { kind: 'view', text: 'open the web view', go: () => { window.location.href = '/'; } },
  ];
  for (const s of sessionList) {
    list.push({
      kind: 'session',
      text: s.title || s.name || s.id,
      go: () => { state.sessionId = s.id; refreshSessions(); },
    });
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
    list.append(span('pal-empty', 'nothing matches'));
    return;
  }
  palItems.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'pal-item' + (i === palIndex ? ' on' : '');
    row.append(span('pal-kind', c.kind), span('pal-text', c.text));
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
  state.sessionId = '';
  resetRun();
  setRun('idle', '-', '');
  $('tb-time').textContent = '';
  refreshSessions();
  $('prompt').focus();
}

// ── Boot ─────────────────────────────────────────────────────────────────

function boot() {
  loadLayout();
  $('split-insp').hidden = $('inspector').hidden;
  $('split-wf').hidden = $('wf').hidden;

  dragger('split-rail', 'rail', 'x', 1, 170, 420);
  dragger('split-insp', 'inspector', 'x', -1, 240, 620);
  dragger('split-wf', 'wf', 'y', 1, 90, 620);

  $('go').onclick = submit;
  $('cancel').onclick = cancelRun;
  $('new-run').onclick = newRun;
  $('pal-open').onclick = openPalette;
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
      $('pal-scrim').hidden ? openPalette() : closePalette();
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
    // composer does not have the caret.
    if (state.approvals.length && document.activeElement !== $('prompt')) {
      if (e.key === 'y') { e.preventDefault(); answer(state.approvals[0].id, true); }
      if (e.key === 'n') { e.preventDefault(); answer(state.approvals[0].id, false); }
    }
    if (e.key === 'Escape' && state.selected) { state.selected = null; renderInspector(); renderEvents(); renderWaterfall(); }
  });

  window.addEventListener('resize', renderWaterfall);

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
      if (e.taskId) state.taskId = e.taskId;
      if (e.type.startsWith('approval.')) refreshApprovals();
      state.events.push(e);
      ingestSpan(e);
      renderEvents();
      renderWaterfall();
      // A span selected while it was open would otherwise keep saying "still
      // running" for ever: the clock tick stops with the run, so the closer
      // that arrives last — the one that ends the task — would never redraw it.
      if (state.selected && state.selected.opener) renderInspector();
    },
  });

  setInterval(health, 15000);
  setInterval(tickClock, 250);
  $('prompt').focus();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
