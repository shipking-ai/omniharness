// The workspace application.
//
// An editor's layout, because that is the shape people already know, with the
// agent in a pane of its own rather than behind a shortcut. A turn is what you
// asked and what came back; the machinery folds into a line you can open, and
// the panel underneath carries the three things no other editor will tell you
// — what happened, how the gateway routed it, and whether the work was checked.

const $ = (id) => document.getElementById(id);

const state = {
  root: '',
  open: [],
  active: '',
  expanded: new Set(),
  turns: [],
  current: null,
  running: false,
  sessionId: '',
  seen: new Set(),
  events: [],
  checks: [],
  spend: 0,
  tokens: 0,
  touched: new Set(),   // files this session's agent wrote to
};

// ── Explorer ─────────────────────────────────────────────────────────────

async function loadDir(path) {
  const r = await OH.api('/v1/fs/tree?path=' + encodeURIComponent(path || '.'));
  if (!r.ok) throw new Error('cannot read ' + (path || '.'));
  return r.json();
}

async function renderTree() {
  const box = $('tree');
  let top;
  try {
    top = await loadDir('.');
  } catch (_) {
    box.innerHTML = '';
    box.append(note('the workspace could not be read'));
    return;
  }
  state.root = top.root || '';
  const short = state.root.split(/[\\/]/).filter(Boolean).pop() || state.root;
  $('proj').textContent = short;
  $('proj').title = state.root;

  box.innerHTML = '';
  await paint(box, top.entries, 0);
  $('side-note').textContent = String(top.entries.length);
}

// paint draws one level, then recurses into whatever is expanded. Directories
// are read only when opened: a repository holds far more files than anyone
// wants delivered at once, and walking it eagerly makes the first paint look
// like a hang.
async function paint(container, entries, depth) {
  for (const e of entries) {
    const row = document.createElement('button');
    row.className = 'node' + (e.dir ? ' dir' : '') + (state.active === e.path ? ' on' : '');
    row.style.paddingLeft = (8 + depth * 12) + 'px';

    const tw = document.createElement('span');
    tw.className = 'tw' + (state.expanded.has(e.path) ? ' open' : '');
    tw.textContent = e.dir ? '▶' : '';
    row.append(tw, icon(e), nameCell(e));
    row.title = e.path;
    row.onclick = () => (e.dir ? toggleDir(e.path) : openFile(e.path));
    container.append(row);

    if (e.dir && state.expanded.has(e.path)) {
      try {
        const sub = await loadDir(e.path);
        await paint(container, sub.entries, depth + 1);
      } catch (_) { /* a directory that vanished is not worth a banner */ }
    }
  }
}

function nameCell(e) {
  const nm = document.createElement('span');
  nm.className = 'nm';
  nm.textContent = e.name;
  return nm;
}

// A one-character mark rather than a file-type icon set. It carries the same
// information at a fraction of the weight, and nothing here is allowed to
// reach for a webfont.
function icon(e) {
  const ic = document.createElement('span');
  ic.className = 'ic';
  ic.textContent = e.dir ? '▸' : '·';
  return ic;
}

function toggleDir(path) {
  if (state.expanded.has(path)) state.expanded.delete(path);
  else state.expanded.add(path);
  renderTree();
}

// ── Editor ───────────────────────────────────────────────────────────────

async function openFile(path) {
  if (!state.open.includes(path)) state.open.push(path);
  state.active = path;
  renderTabs();
  renderTree();

  const code = $('code');
  $('blank').hidden = true;
  code.hidden = false;
  $('crumb').hidden = false;
  $('crumb').textContent = path.split('/').join('  ›  ');

  let body;
  try {
    const r = await OH.api('/v1/fs/file?path=' + encodeURIComponent(path));
    body = await r.json();
  } catch (_) {
    code.innerHTML = '';
    code.append(note('that file could not be read'));
    return;
  }
  code.innerHTML = '';
  if (body.binary) {
    code.append(note(path + ' is not text'));
    $('pos').textContent = '—';
    return;
  }

  const pre = document.createElement('pre');
  const html = OHHighlight.highlight(body.content || '', body.language || 'text');
  // Split after highlighting, not before: a block comment or a template
  // literal spans lines, and highlighting each line alone would reopen the
  // token on every one of them.
  const lines = html.split('\n');
  const touched = state.touched.has(path);
  pre.innerHTML = lines.map((l, i) =>
    '<span class="ln' + (touched ? ' touched' : '') + '" data-n="' + (i + 1) + '">' +
    (l || ' ') + '</span>').join('\n');
  code.append(pre);
  code.scrollTop = 0;
  $('pos').textContent = lines.length + ' lines · ' + (body.language || 'text');
  if (body.truncated) code.append(note('showing the first part of a large file'));
}

function renderTabs() {
  const bar = $('tabs');
  bar.innerHTML = '';
  for (const path of state.open) {
    const t = document.createElement('button');
    t.className = 'tab' + (path === state.active ? ' on' : '');
    const nm = document.createElement('span');
    nm.textContent = path.split('/').pop();
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '×';
    x.onclick = (e) => { e.stopPropagation(); closeTab(path); };
    t.append(nm, x);
    t.title = path;
    t.onclick = () => openFile(path);
    bar.append(t);
  }
}

function closeTab(path) {
  state.open = state.open.filter((p) => p !== path);
  if (state.active === path) {
    state.active = state.open[state.open.length - 1] || '';
    if (state.active) { openFile(state.active); return; }
    $('code').hidden = true;
    $('crumb').hidden = true;
    $('blank').hidden = false;
    $('pos').textContent = '—';
  }
  renderTabs();
  renderTree();
}

// ── Find ─────────────────────────────────────────────────────────────────

let findTimer = null;
async function runFind() {
  const q = $('q').value.trim();
  const box = $('hits');
  if (!q) { box.innerHTML = ''; box.append(note('type to find files by name')); return; }
  try {
    const r = await OH.api('/v1/fs/find?q=' + encodeURIComponent(q));
    const body = await r.json();
    box.innerHTML = '';
    if (!body.hits || !body.hits.length) { box.append(note('nothing matches')); return; }
    for (const h of body.hits) {
      const b = document.createElement('button');
      b.className = 'hit';
      const nm = document.createElement('span');
      nm.textContent = h.name;
      const p = document.createElement('span');
      p.className = 'p';
      p.textContent = h.path;
      b.append(nm, p);
      b.onclick = () => { showView('explorer'); openFile(h.path); };
      box.append(b);
    }
  } catch (_) {
    box.innerHTML = '';
    box.append(note('the search failed'));
  }
}

// ── Capabilities ─────────────────────────────────────────────────────────
//
// An editor calls these extensions. Here they are whatever the tool registry
// holds — including anything an MCP server contributed at start-up — listed by
// what they can do rather than by what they are called.

async function renderCaps() {
  const box = $('caps');
  try {
    const r = await OH.api('/v1/capabilities');
    const body = await r.json();
    const tools = body.tools || [];
    box.innerHTML = '';
    if (!tools.length) { box.append(note('no tools are registered')); return; }
    for (const t of tools) {
      const row = document.createElement('div');
      row.className = 'cap';
      const b = document.createElement('b');
      b.textContent = t.name;
      const s = document.createElement('span');
      s.textContent = (t.capabilities || []).join(' · ') || t.description || '';
      row.append(b, s);
      row.title = t.description || '';
      box.append(row);
    }
    $('side-note').textContent = tools.length + ' tools';
  } catch (_) {
    box.innerHTML = '';
    box.append(note('the capability list could not be read'));
  }
}

// ── Route ────────────────────────────────────────────────────────────────

async function renderRoute() {
  const box = $('p-route');
  try {
    const r = await OH.api('/v1/route');
    const body = await r.json();
    box.innerHTML = '';
    if (body.unavailable) { box.append(note('the gateway did not explain itself: ' + body.unavailable)); return; }
    const events = body.events || [];
    if (!events.length) { box.append(note('no routed calls yet')); return; }
    for (const e of events.slice(0, 60)) {
      const row = document.createElement('div');
      // A fallback or a retry is the interesting case, so it is coloured.
      const tone = e.outcome !== 'success' ? 'bad' : (e.fallbackUsed || e.retries ? 'warn' : 'ok');
      row.className = 'prow ' + tone;
      const detail = [
        e.provider,
        e.inputTokens ? e.inputTokens + ' in' : '',
        e.outputTokens ? e.outputTokens + ' out' : '',
        e.retries ? e.retries + ' retries' : '',
        e.fallbackUsed ? 'failed over' : '',
      ].filter(Boolean).join(' · ');
      row.append(
        cell('s', e.outcome === 'success' ? 'ok' : 'failed'),
        cell('k', e.model || ''),
        cell('d', detail),
        cell('t', e.latencyMs ? OH.fmtMillis(e.latencyMs) : ''));
      box.append(row);
    }
  } catch (_) {
    box.innerHTML = '';
    box.append(note('the routing view could not be read'));
  }
}

// ── Panel ────────────────────────────────────────────────────────────────

function renderEventsPanel() {
  const box = $('p-events');
  for (const stale of box.querySelectorAll('.prow')) stale.remove();
  const empty = box.querySelector('.pempty');
  if (empty) empty.hidden = state.events.length > 0;
  const atBottom = box.parentElement.scrollHeight - box.parentElement.scrollTop
    - box.parentElement.clientHeight < 50;
  for (const e of state.events.slice(-300)) {
    const row = document.createElement('div');
    row.className = 'prow ' + OH.toneOf(e.type);
    row.append(
      cell('s', OH.stateOf(e.type)),
      cell('k', e.type),
      cell('d', OH.phraseOf(e.type) + (OH.summarise(e) ? ' · ' + OH.summarise(e) : '')),
      cell('t', OH.clockOf(e)));
    box.append(row);
  }
  if (atBottom) box.parentElement.scrollTop = box.parentElement.scrollHeight;
}

function renderChecks() {
  const box = $('p-checks');
  for (const stale of box.querySelectorAll('.prow')) stale.remove();
  const empty = box.querySelector('.pempty');
  if (empty) empty.hidden = state.checks.length > 0;
  for (const c of state.checks) {
    const row = document.createElement('div');
    row.className = 'prow ' + (c.outcome === 'pass' ? 'ok' : c.outcome === 'fail' ? 'bad' : 'warn');
    row.append(cell('s', c.outcome), cell('k', c.evaluator), cell('d', c.reason || ''), cell('t', c.at));
    box.append(row);
  }
}

function cell(cls, text) {
  const el = document.createElement('span');
  el.className = cls;
  el.textContent = text;
  return el;
}

function note(text) {
  const el = document.createElement('div');
  el.className = 'empty-note';
  el.textContent = text;
  return el;
}

// ── The conversation ─────────────────────────────────────────────────────

function newTurn(prompt) {
  const turn = {
    prompt, answer: '', tone: 'busy', steps: [], model: '', cost: 0,
    started: Date.now(), ms: 0, fresh: true,
  };
  state.turns.push(turn);
  state.current = turn;
  renderThread();
  return turn;
}

function ingest(e) {
  const d = e.data || {};

  state.events.push(e);
  renderEventsPanel();

  // Files the agent wrote are marked in the editor, so a file that changed
  // under you says so instead of quietly differing from what you last read.
  if (e.type === 'tool.completed' && (d.tool === 'write_file' || d.tool === 'edit_file')) {
    const p = (d.input && d.input.path) || d.path;
    if (p) {
      state.touched.add(String(p).replace(/^.*[\\/](?=[^\\/]*$)/, (m) => m));
      state.touched.add(String(p));
    }
  }
  if (e.type === 'evaluation.completed') {
    state.checks.push({
      evaluator: d.evaluator || 'evaluator',
      outcome: d.outcome || 'unknown',
      reason: d.reason || '',
      at: OH.clockOf(e),
    });
    renderChecks();
  }

  if (e.type === 'task.created' && !state.current) {
    newTurn(d.prompt || '');
    // A run can begin somewhere other than this composer — another window, the
    // TUI, a curl against the API. The thread filled in for those already; the
    // state in the title bar went on saying "idle" while work was visibly
    // happening beside it.
    if (!state.running) { state.running = true; setState('running', 'running'); }
    return;
  }
  if (!state.current) return;
  const t = state.current;

  if (e.type === 'model.responded') {
    const model = OH.modelOf(d);
    if (model) { t.model = model; $('model').textContent = model; }
    if (d.costUsd) { t.cost += d.costUsd; state.spend += d.costUsd; }
    state.tokens += (d.tokensIn || 0) + (d.tokensOut || 0);
    renderSpend();
  }
  if (e.type === 'task.completed' || e.type === 'task.failed' || e.type === 'task.cancelled') {
    t.answer = d.summary || d.output || OH.summarise(e) ||
      (e.type === 'task.completed' ? '' : 'the run did not finish');
    t.tone = e.type === 'task.completed' ? 'ok' : 'bad';
    t.ms = Date.now() - t.started;
    state.current = null;
    state.running = false;
    setState(t.tone === 'ok' ? 'done' : 'failed', t.tone === 'ok' ? 'done' : 'failed');
    renderThread();
    renderRoute();
    return;
  }

  t.steps.push({
    at: OH.clockOf(e),
    state: OH.stateOf(e.type),
    tone: OH.toneOf(e.type),
    what: OH.phraseOf(e.type),
    detail: OH.summarise(e),
  });
  renderThread();
}

function renderSpend() {
  $('spend').textContent = OH.fmtCost(state.spend) || '~$0.00';
  $('tokens').textContent = state.tokens.toLocaleString() + ' tok';
}

function renderThread() {
  const box = $('thread');
  $('thread-empty').hidden = state.turns.length > 0;
  for (const stale of box.querySelectorAll('.turn')) stale.remove();
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;

  for (const t of state.turns) {
    const asked = document.createElement('div');
    asked.className = 'turn you' + (t.fresh ? ' fresh' : '');
    asked.append(who('you', 'Y', ''), said(t.prompt));
    box.append(asked);

    const reply = document.createElement('div');
    reply.className = 'turn oh' + (t.fresh ? ' fresh' : '');
    // The speaker is the model that answered — not "omniharness", and not the
    // alias that was asked for. A reply came from inception/mercury-2.5 or it
    // came from anthropic/claude-sonnet-5, and which one is the single most
    // useful thing on the line.
    reply.append(who(t.model || 'routing…', 'M', t.model ? provider(t.model) : ''));

    if (t.steps.length) {
      const det = document.createElement('details');
      det.className = 'steps';
      const sum = document.createElement('summary');
      const tw = document.createElement('span');
      tw.className = 'tw';
      tw.textContent = '▶';
      const label = document.createElement('span');
      label.textContent = t.steps.length + ' steps' + (t.ms ? ' · ' + OH.fmtMillis(t.ms) : '');
      sum.append(tw, label);
      if (t.cost) sum.append(cell('cost', OH.fmtCost(t.cost)));
      det.append(sum);
      for (const s of t.steps.slice(-80)) {
        const row = document.createElement('div');
        row.className = 'sstep ' + s.tone;
        row.append(cell('s', s.state),
          cell('w', s.what + (s.detail ? ' · ' + s.detail : '')),
          cell('d', s.at));
        det.append(row);
      }
      reply.append(det);
    }
    if (t.answer) reply.append(said(t.answer));
    box.append(reply);
    t.fresh = false;
  }
  $('thread-note').textContent = state.turns.length ? state.turns.length + ' turns' : '';
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function said(text) {
  const el = document.createElement('div');
  el.className = 'said';
  el.textContent = text;
  return el;
}

// provider is the first half of a provider/model reference — whose machine
// answered.
function provider(ref) {
  const slash = ref.indexOf('/');
  return slash > 0 ? ref.slice(0, slash) : '';
}

function who(name, initial, home) {
  const row = document.createElement('div');
  row.className = 'who';
  const av = document.createElement('span');
  av.className = 'av';
  av.textContent = initial;
  const nm = document.createElement('span');
  nm.textContent = name;
  row.append(av, nm);
  if (home) row.append(cell('home', home));
  return row;
}

// ── Running ──────────────────────────────────────────────────────────────

function setState(word, tone) {
  const el = $('state');
  el.className = 'state ' + (tone || '');
  el.textContent = word;
  const ticks = document.createElement('span');
  ticks.className = 'ticks';
  el.append(ticks);
  document.title = state.running ? 'OmniHarness · working' : 'OmniHarness';
}

async function send() {
  const prompt = $('prompt').value.trim();
  if (!prompt || state.running) return;
  state.running = true;
  $('go').disabled = true;
  $('prompt').value = '';
  autosize();
  newTurn(prompt);
  setState('running', 'running');

  try {
    const body = await OH.run(prompt, state.sessionId);
    state.sessionId = body.sessionId || state.sessionId;
    if (state.current) {
      // The response carries the result outright, so a turn does not depend on
      // task.completed reaching this client. A dropped terminal event used to
      // leave the answer permanently blank under a full list of steps.
      const t = state.current;
      const result = (body.task && body.task.result) || {};
      t.answer = result.summary || result.output || t.answer ||
        (body.error ? String(body.error) : '');
      t.tone = body.error || (body.task && body.task.status !== 'completed') ? 'bad' : 'ok';
      t.ms = Date.now() - t.started;
      state.current = null;
      renderThread();
      setState(t.tone === 'ok' ? 'done' : 'failed', t.tone === 'ok' ? 'done' : 'failed');
    }
  } catch (_) {
    if (state.current) {
      state.current.answer = 'the harness did not answer';
      state.current.tone = 'bad';
      state.current = null;
    }
    setState('failed', 'failed');
    renderThread();
  } finally {
    state.running = false;
    $('go').disabled = false;
    // The tree may have changed under us — that is the whole point of an agent
    // with filesystem tools.
    renderTree();
    if (state.active) openFile(state.active);
    renderRoute();
  }
}

async function health() {
  try {
    const h = await OH.health();
    $('version').textContent = (h.version || '').replace(/^omniharness /, 'v').replace(/ .*/, '');
    $('gw').textContent = h.omniroute ? 'gateway' : 'gateway unreachable';
    $('gw-dot').className = 'dot ' + (h.omniroute ? 'ok' : 'bad');
  } catch (_) {
    $('gw').textContent = 'no harness';
    $('gw-dot').className = 'dot bad';
  }
}

function autosize() {
  const el = $('prompt');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 170) + 'px';
}

// ── Views and layout ─────────────────────────────────────────────────────

function showView(name) {
  for (const b of document.querySelectorAll('.act')) b.classList.toggle('on', b.dataset.view === name);
  for (const v of document.querySelectorAll('.side .view')) v.classList.toggle('on', v.id === 'view-' + name);
  $('side-title').textContent = { explorer: 'Explorer', search: 'Search', caps: 'Capabilities' }[name] || name;
  $('side-note').textContent = '';
  if (name === 'caps') renderCaps();
  if (name === 'explorer') renderTree();
  if (name === 'search') $('q').focus();
  save();
}

function showPanel(name) {
  for (const b of document.querySelectorAll('.ptab')) b.classList.toggle('on', b.dataset.p === name);
  for (const v of document.querySelectorAll('.pview')) v.classList.toggle('on', v.id === 'p-' + name);
  if (name === 'route') renderRoute();
  save();
}

function save() {
  try {
    localStorage.setItem('oh.app', JSON.stringify({
      side: $('side').offsetWidth,
      chat: $('chat').offsetWidth,
      panel: $('panel').classList.contains('collapsed') ? 0 : $('panel').offsetHeight,
      view: (document.querySelector('.act.on') || {}).dataset?.view || 'explorer',
      ptab: (document.querySelector('.ptab.on') || {}).dataset?.p || 'events',
    }));
  } catch (_) { /* private mode: the layout is simply not remembered */ }
}

function dragger(handleId, paneId, axis, sign, min, max) {
  const handle = $(handleId), pane = $(paneId);
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
      else pane.style.height = next + 'px';
    };
    const up = () => {
      handle.classList.remove('dragging');
      document.body.classList.remove('resizing', 'resizing-v');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      save();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

function boot() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('oh.app') || '{}'); } catch (_) { /* first run */ }
  if (saved.side) $('side').style.width = saved.side + 'px';
  if (saved.chat) $('chat').style.width = saved.chat + 'px';
  if (saved.panel) $('panel').style.height = saved.panel + 'px';

  dragger('split-side', 'side', 'x', 1, 180, 460);
  dragger('split-chat', 'chat', 'x', -1, 300, 720);
  dragger('split-panel', 'panel', 'y', -1, 90, 560);

  for (const b of document.querySelectorAll('.act')) b.onclick = () => showView(b.dataset.view);
  for (const b of document.querySelectorAll('.ptab')) b.onclick = () => showPanel(b.dataset.p);
  $('panel-toggle').onclick = () => {
    const p = $('panel');
    p.classList.toggle('collapsed');
    $('panel-toggle').textContent = p.classList.contains('collapsed') ? 'show' : 'hide';
    save();
  };

  $('q').addEventListener('input', () => {
    clearTimeout(findTimer);
    // A keystroke walks the repository, so it waits for a pause rather than
    // firing a walk per character.
    findTimer = setTimeout(runFind, 160);
  });

  $('go').onclick = send;
  $('prompt').addEventListener('input', autosize);
  $('prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
      e.preventDefault(); showView('search');
    }
  });

  health();
  renderSpend();
  renderRoute();
  showView(saved.view || 'explorer');
  showPanel(saved.ptab || 'events');

  // Open something on arrival. An editor that starts on an empty pane looks
  // broken, and the file that explains a repository is the obvious default.
  (async () => {
    await renderTree();
    for (const first of ['README.md', 'AGENTS.md', 'go.mod']) {
      try {
        const r = await OH.api('/v1/fs/file?path=' + encodeURIComponent(first));
        if (r.ok) { openFile(first); return; }
      } catch (_) { /* try the next */ }
    }
  })();

  OH.connect({
    onLink: () => {},
    onGap: (n) => { $('gaps').hidden = false; $('gaps').textContent = n + ' events dropped'; },
    onEvent: (e) => {
      if (e.id && state.seen.has(e.id)) return;
      if (e.id) state.seen.add(e.id);
      ingest(e);
    },
  });
  setInterval(health, 15000);
  $('prompt').focus();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
