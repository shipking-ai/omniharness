// The web view: one column, a live event stream, a composer.
//
// This is the surface someone reaches by opening the URL that `omniharness
// serve` prints. It is deliberately the plain one — a page that reads well in
// a browser tab at any width, on a machine that may not have a Chromium-family
// browser at all. The desktop shell at /desktop is the other end of that
// trade: more panes, more keyboard, one window.
//
// Everything that talks to the harness lives in core.js. What is here is
// layout and behaviour.

const state = {
  events: [],
  approvals: [],
  taskId: '',
  sessionId: '',
  running: false,
};

const $ = (id) => document.getElementById(id);

function renderEvents() {
  const stream = $('stream');
  const has = state.events.length > 0;
  $('empty').hidden = has;
  stream.hidden = !has;
  stream.innerHTML = '';
  for (const e of state.events.slice(-400)) {
    const row = document.createElement('div');
    row.className = 'ev ' + OH.toneOf(e.type);
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
    stream.append(row);
  }
  const scroll = $('scroll');
  scroll.scrollTop = scroll.scrollHeight;
}

function renderApprovals() {
  const box = $('approvals');
  box.innerHTML = '';
  for (const a of state.approvals) {
    const card = document.createElement('div');
    card.className = 'approval';

    const top = document.createElement('div');
    top.className = 'approval-top';
    const tool = document.createElement('span');
    tool.className = 'approval-tool';
    tool.textContent = a.tool || 'this task';
    const risk = document.createElement('span');
    risk.className = 'approval-risk';
    risk.textContent = (a.risk || 'unknown') + ' risk';
    top.append(tool, risk);

    const why = document.createElement('div');
    why.className = 'approval-why';
    why.textContent = a.reason || 'waiting for your decision';

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
    // Deny sits first so approve is never the button under the cursor by
    // accident; approving is the decision that deserves a deliberate move.
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
  } catch (_) { /* the stream brings it round again */ }
}

function setRun(title, sub, chipText, tone) {
  $('run-title').textContent = title;
  $('run-sub').textContent = sub;
  const chip = $('chip');
  chip.className = 'chip ' + (tone || '');
  chip.textContent = chipText;
}

async function refreshSessions() {
  try {
    const list = (await OH.sessions()).slice(0, 40);
    const box = $('sessions');
    box.innerHTML = '';
    if (list.length === 0) {
      const none = document.createElement('div');
      none.className = 'sessions-empty';
      none.textContent = 'none yet';
      box.append(none);
      return;
    }
    for (const s of list) {
      const item = document.createElement('button');
      item.className = 'session' + (s.id === state.sessionId ? ' active' : '');
      item.textContent = s.title || s.name || s.id;
      item.title = item.textContent;
      item.onclick = () => { state.sessionId = s.id; refreshSessions(); };
      box.append(item);
    }
  } catch (_) { /* the rail is not worth an error banner */ }
}

async function submit() {
  const prompt = $('prompt').value.trim();
  if (!prompt || state.running) return;
  state.running = true;
  state.events = [];
  renderEvents();
  $('go').disabled = true;
  $('cancel').hidden = false;
  $('prompt').value = '';
  autosize();
  setRun(prompt, 'starting', 'running', 'busy');

  try {
    const body = await OH.run(prompt, state.sessionId);
    state.sessionId = body.sessionId || state.sessionId;
    const status = (body.task && body.task.status) || (body.error ? 'failed' : 'unknown');
    const detail = body.error ? String(body.error).slice(0, 120) : (state.taskId || '');
    setRun(prompt, detail, status, status === 'completed' ? 'ok' : 'bad');
  } catch (_) {
    setRun(prompt, 'the server did not answer', 'unreachable', 'bad');
  } finally {
    state.running = false;
    state.taskId = '';
    $('go').disabled = false;
    $('cancel').hidden = true;
    refreshApprovals();
    refreshSessions();
  }
}

async function cancel() {
  if (!state.taskId) return;
  await OH.cancelTask(state.taskId);
}

async function health() {
  try {
    const h = await OH.health();
    $('version').textContent = (h.version || '').replace(/^omniharness /, 'v');
    $('gw').textContent = h.omniroute ? 'connected' : 'unreachable';
    $('gw-dot').className = 'dot ' + (h.omniroute ? 'ok' : 'bad');
  } catch (_) {
    $('gw').textContent = 'no server';
    $('gw-dot').className = 'dot bad';
  }
}

// The composer grows with the text instead of scrolling inside a fixed box,
// which is what makes a multi-line prompt feel like writing rather than typing
// into a slot.
function autosize() {
  const el = $('prompt');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 180) + 'px';
}

function boot() {
  const scene = createScene($('bg'));
  if (!scene) {
    // No WebGL: the page keeps working, it simply loses its background.
    $('bg').hidden = true;
  } else {
    let last = performance.now();
    const tick = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      scene.frame(dt);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  $('go').onclick = submit;
  $('cancel').onclick = cancel;
  $('new-run').onclick = () => {
    state.sessionId = '';
    state.events = [];
    renderEvents();
    setRun('idle', 'nothing running', 'idle', '');
    refreshSessions();
    $('prompt').focus();
  };
  $('prompt').addEventListener('input', autosize);
  $('prompt').addEventListener('keydown', (e) => {
    // Enter sends; Shift+Enter is a newline. The same bargain as the TUI.
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  });

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
      if (e.type === 'strategy.selected' && state.running) {
        setRun($('run-title').textContent, OH.summarise(e), 'running', 'busy');
      }
      state.events.push(e);
      renderEvents();
      if (scene) {
        const tone = OH.toneOf(e.type);
        scene.excite(e.type.startsWith('model') || e.type.startsWith('tool') ? 0.5 : 0.25,
          tone === 'bad' ? 'error' : tone === 'warn' ? 'warn' : 'idle');
      }
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
