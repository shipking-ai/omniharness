// The workspace application.
//
// Three panes: the files, what you are reading, and the agent. The
// conversation is the surface you work in — a turn is what you asked and what
// came back, and the machinery that produced it folds into one line you can
// open. The other browser surfaces put that machinery front and centre, which
// is right for watching a run and wrong for doing the work.

const $ = (id) => document.getElementById(id);

const state = {
  root: '',
  open: [],          // tabs, most recently opened last
  active: '',        // path of the visible tab
  expanded: new Set(),
  turns: [],         // { id, prompt, answer, tone, steps[], model, cost, ms }
  current: null,     // the turn being built while a task runs
  running: false,
  sessionId: '',
  seen: new Set(),
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
    box.append(tag('tree-empty', 'the workspace could not be read'));
    return;
  }
  state.root = top.root || '';
  $('cwd').textContent = state.root;
  $('cwd').title = state.root;

  box.innerHTML = '';
  await paint(box, top.entries, 0);
  $('tree-note').textContent = top.entries.length ? String(top.entries.length) : '';
}

// paint draws one level, then recurses into whatever is expanded. Directories
// are read only when they are opened: a repository has far more files than
// anyone wants delivered at once, and eagerly walking it makes the first paint
// look like a hang.
async function paint(container, entries, depth) {
  for (const e of entries) {
    const row = document.createElement('button');
    row.className = 'node' + (e.dir ? ' dir' : '') + (state.active === e.path ? ' on' : '');
    row.style.paddingLeft = (12 + depth * 13) + 'px';

    const tw = document.createElement('span');
    tw.className = 'tw' + (state.expanded.has(e.path) ? ' open' : '');
    tw.textContent = e.dir ? '▶' : '';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = e.name;
    row.append(tw, nm);
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
  code.innerHTML = '';

  let body;
  try {
    const r = await OH.api('/v1/fs/file?path=' + encodeURIComponent(path));
    body = await r.json();
  } catch (_) {
    code.append(tag('blank', 'that file could not be read'));
    return;
  }
  if (body.binary) {
    code.append(tag('blank', path + ' is not text'));
    return;
  }

  const pre = document.createElement('pre');
  const html = OHHighlight.highlight(body.content || '', body.language || 'text');
  // Split after highlighting, not before: a block comment or a template
  // literal spans lines, and highlighting each line alone would reopen the
  // token on every one of them.
  const lines = html.split('\n');
  pre.innerHTML = lines.map((l, i) =>
    '<span class="ln" data-n="' + (i + 1) + '">' + (l || ' ') + '</span>').join('\n');
  code.append(pre);
  if (body.truncated) {
    code.append(tag('blank', 'showing the first part of a large file'));
  }
  code.scrollTop = 0;
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
    $('blank').hidden = false;
  }
  renderTabs();
  renderTree();
}

// ── The conversation ─────────────────────────────────────────────────────
//
// A turn is one exchange. Events arriving between task.created and
// task.completed are its steps, and they are summarised rather than listed:
// the count, the elapsed time and the cost is what somebody reading a
// conversation wants, with the detail one click away.

function newTurn(prompt) {
  const turn = {
    id: 't' + Date.now(),
    prompt: prompt,
    answer: '',
    tone: 'busy',
    steps: [],
    model: '',
    cost: 0,
    started: Date.now(),
    ms: 0,
    fresh: true,
  };
  state.turns.push(turn);
  state.current = turn;
  renderThread();
  return turn;
}

function ingest(e) {
  const d = e.data || {};
  const turn = state.current;

  if (e.type === 'task.created' && !turn) {
    newTurn(d.prompt || '');
    // A run can begin somewhere other than this composer — another window, the
    // TUI, a curl against the API. The thread filled in for those already; the
    // state in the title bar went on saying "idle" while work was visibly
    // happening beside it.
    if (!state.running) {
      state.running = true;
      setState('running', 'running');
    }
    return;
  }
  if (!state.current) return;
  const t = state.current;

  if (e.type === 'model.responded') {
    const model = OH.modelOf(d);
    if (model) t.model = model;
    if (d.costUsd) t.cost += d.costUsd;
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
    return;
  }

  // Everything else is machinery. Kept, summarised, folded.
  t.steps.push({
    at: OH.clockOf(e),
    state: OH.stateOf(e.type),
    tone: OH.toneOf(e.type),
    what: OH.phraseOf(e.type),
    detail: OH.summarise(e),
  });
  renderThread();
}

function renderThread() {
  const box = $('thread');
  $('thread-empty').hidden = state.turns.length > 0;
  for (const stale of box.querySelectorAll('.turn')) stale.remove();

  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;

  for (const t of state.turns) {
    const wrap = document.createElement('div');
    wrap.className = 'turn you' + (t.fresh ? ' fresh' : '');

    wrap.append(who('you', 'Y', ''));
    wrap.append(tag('said', t.prompt));
    box.append(wrap);

    const reply = document.createElement('div');
    reply.className = 'turn oh' + (t.fresh ? ' fresh' : '');
    // The speaker is the model that answered — not "omniharness", and not the
    // alias that was asked for. A reply came from inception/mercury-2.5 or it
    // came from anthropic/claude-sonnet-5, and which one is the single most
    // useful thing on the line. The harness is the thing you are talking
    // through, not the thing talking.
    reply.append(who(t.model || 'routing…', 'M', t.model ? modelHome(t.model) : ''));

    if (t.steps.length) {
      const det = document.createElement('details');
      det.className = 'steps';
      const sum = document.createElement('summary');
      const tw = document.createElement('span');
      tw.className = 'tw';
      tw.textContent = '▶';
      const label = document.createElement('span');
      const done = t.ms ? ' · ' + OH.fmtMillis(t.ms) : '';
      label.textContent = t.steps.length + ' steps' + done;
      sum.append(tw, label);
      if (t.cost) sum.append(tag('cost', OH.fmtCost(t.cost)));
      det.append(sum);
      for (const s of t.steps.slice(-60)) {
        const row = document.createElement('div');
        row.className = 'step ' + s.tone;
        row.append(tag('s', s.state), tag('w', s.what + (s.detail ? ' · ' + s.detail : '')), tag('d', s.at));
        det.append(row);
      }
      reply.append(det);
    }

    if (t.answer) reply.append(tag('said', t.answer));
    box.append(reply);
    t.fresh = false;
  }
  $('thread-note').textContent = state.turns.length ? state.turns.length + ' turns' : '';
  if (atBottom) box.scrollTop = box.scrollHeight;
}

// modelHome is the provider half of a provider/model reference — the part
// that says whose machine answered.
function modelHome(ref) {
  const slash = ref.indexOf('/');
  return slash > 0 ? ref.slice(0, slash) : '';
}

function who(name, initial, model) {
  const row = document.createElement('div');
  row.className = 'who';
  const av = document.createElement('span');
  av.className = 'av';
  av.textContent = initial;
  const nm = document.createElement('span');
  nm.textContent = name;
  row.append(av, nm);
  if (model) row.append(tag('model', model));
  return row;
}

function tag(cls, text) {
  const el = document.createElement('span');
  el.className = cls;
  el.textContent = text;
  return el;
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
      // The response carries the result outright, so the turn does not depend
      // on task.completed reaching this client. A dropped terminal event used
      // to leave the answer permanently blank under a full list of steps —
      // the run had finished and the window could not say what it said.
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
    // The tree may have changed under us — that is the whole point of an
    // agent with filesystem tools.
    renderTree();
    if (state.active) openFile(state.active);
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
  el.style.height = Math.min(el.scrollHeight, 180) + 'px';
}

function dragger(handleId, paneId, sign, min, max) {
  const handle = $(handleId), pane = $(paneId);
  handle.addEventListener('pointerdown', (down) => {
    down.preventDefault();
    handle.setPointerCapture(down.pointerId);
    handle.classList.add('dragging');
    document.body.classList.add('resizing');
    const start = down.clientX, from = pane.offsetWidth;
    const move = (e) => {
      pane.style.width = Math.min(max, Math.max(min, from + sign * (e.clientX - start))) + 'px';
    };
    const up = () => {
      handle.classList.remove('dragging');
      document.body.classList.remove('resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      try {
        localStorage.setItem('oh.app.layout', JSON.stringify({
          files: $('files').offsetWidth, chat: $('chat').offsetWidth,
        }));
      } catch (_) { /* private mode: the layout is simply not remembered */ }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

function boot() {
  try {
    const saved = JSON.parse(localStorage.getItem('oh.app.layout') || '{}');
    if (saved.files) $('files').style.width = saved.files + 'px';
    if (saved.chat) $('chat').style.width = saved.chat + 'px';
  } catch (_) { /* first run */ }

  dragger('split-files', 'files', 1, 170, 460);
  dragger('split-chat', 'chat', -1, 320, 760);

  $('go').onclick = send;
  $('prompt').addEventListener('input', autosize);
  $('prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  health();
  renderTree();
  OH.connect({
    onLink: (s) => { $('link').textContent = s; },
    onGap: (n) => { $('gaps').hidden = false; $('gaps').textContent = n + ' events dropped'; },
    onEvent: (e) => {
      if (e.id && state.seen.has(e.id)) return;
      if (e.id) state.seen.add(e.id);
      if (e.type === 'model.responded') {
        const m = OH.modelOf(e.data || {});
        if (m) $('model').textContent = m;
      }
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
