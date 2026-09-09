// The routing graph, and the harness UI that sits on top of it.
//
// No bundler, no CDN, no dependency. `omniharness serve` embeds this file in
// the binary and serves it from the same origin as the API, so the whole thing
// works on a laptop with no network — which is the point of a local-first
// harness. A three.js tag would have undone that for a background.

// ── A very small 3D layer ────────────────────────────────────────────────
// Enough matrix maths for one perspective scene. Column-major, like WebGL.

function perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2);
  return [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0,
  ];
}

function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

function rotationY(t) {
  const c = Math.cos(t), s = Math.sin(t);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}

function rotationX(t) {
  const c = Math.cos(t), s = Math.sin(t);
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
}

function translation(x, y, z) {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

// ── The scene ────────────────────────────────────────────────────────────
// Nodes are providers and agents; edges are routes between them. It is not
// decoration: a model call lights the edge it travelled, a tool call pulses
// its node, and a failure flashes red. What you see is the run.

const NODE_COUNT = 260;
const LINK_DISTANCE = 3.8;
const MAX_LINKS = 700;

function createScene(canvas) {
  const gl = canvas.getContext('webgl', { alpha: false, antialias: true });
  if (!gl) return null;

  // A GPU context is not forever: a driver reset, a laptop switching graphics,
  // or a software renderer under load all take it away, and everything drawn
  // afterwards silently does nothing. Found the hard way — a headless run kept
  // showing one frozen frame no matter what the scene was told to do, and the
  // only sign was CONTEXT_LOST_WEBGL in the console.
  let lost = false;
  canvas.addEventListener('webglcontextlost', (e) => {
    // Without preventDefault the context is never eligible for restoration.
    e.preventDefault();
    lost = true;
  });
  canvas.addEventListener('webglcontextrestored', () => {
    // Rebuilding the scene is the honest response: every buffer, shader and
    // uniform location belonged to the context that went away.
    lost = false;
    const rebuilt = createScene(canvas);
    if (rebuilt) Object.assign(scene, rebuilt);
  });

  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn('shader:', gl.getShaderInfoLog(sh));
      return null;
    }
    return sh;
  };

  const program = gl.createProgram();
  const vs = compile(gl.VERTEX_SHADER, `
    attribute vec3 position;
    attribute float energy;
    uniform mat4 mvp;
    uniform float pointScale;
    varying float vEnergy;
    varying float vDepth;
    void main() {
      vec4 clip = mvp * vec4(position, 1.0);
      gl_Position = clip;
      vEnergy = energy;
      vDepth = clamp(1.0 - (clip.w - 6.0) / 26.0, 0.15, 1.0);
      gl_PointSize = pointScale * (1.0 + energy * 2.2) * vDepth;
    }
  `);
  const fs = compile(gl.FRAGMENT_SHADER, `
    precision mediump float;
    uniform vec3 baseColor;
    uniform vec3 hotColor;
    uniform float alpha;
    uniform float round;
    varying float vEnergy;
    varying float vDepth;
    void main() {
      float mask = 1.0;
      if (round > 0.5) {
        vec2 d = gl_PointCoord - vec2(0.5);
        float r = dot(d, d);
        if (r > 0.25) discard;
        mask = smoothstep(0.25, 0.02, r);
      }
      vec3 color = mix(baseColor, hotColor, clamp(vEnergy, 0.0, 1.0));
      gl_FragColor = vec4(color, alpha * mask * vDepth);
    }
  `);
  if (!vs || !fs) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);

  const loc = {
    position: gl.getAttribLocation(program, 'position'),
    energy: gl.getAttribLocation(program, 'energy'),
    mvp: gl.getUniformLocation(program, 'mvp'),
    pointScale: gl.getUniformLocation(program, 'pointScale'),
    baseColor: gl.getUniformLocation(program, 'baseColor'),
    hotColor: gl.getUniformLocation(program, 'hotColor'),
    alpha: gl.getUniformLocation(program, 'alpha'),
    round: gl.getUniformLocation(program, 'round'),
  };

  const nodes = [];
  for (let i = 0; i < NODE_COUNT; i++) {
    // Spread through a slab rather than a cube: the camera looks along z, and
    // a cube wastes most of its volume outside the frustum.
    nodes.push({
      x: (Math.random() - 0.5) * 26,
      y: (Math.random() - 0.5) * 15,
      z: (Math.random() - 0.5) * 16,
      vx: (Math.random() - 0.5) * 0.006,
      vy: (Math.random() - 0.5) * 0.006,
      vz: (Math.random() - 0.5) * 0.006,
      energy: 0,
    });
  }

  const pointPos = new Float32Array(NODE_COUNT * 3);
  const pointEnergy = new Float32Array(NODE_COUNT);
  const linkPos = new Float32Array(MAX_LINKS * 6);
  const linkEnergy = new Float32Array(MAX_LINKS * 2);
  const posBuf = gl.createBuffer();
  const energyBuf = gl.createBuffer();
  const linkPosBuf = gl.createBuffer();
  const linkEnergyBuf = gl.createBuffer();

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.disable(gl.DEPTH_TEST);

  const readVar = (name, fallback) => {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const m = /^#?([0-9a-f]{6})$/i.exec(v);
    if (!m) return fallback;
    const n = parseInt(m[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  };

  let spin = 0;
  let pulse = 0;
  let tone = 'idle';

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  function frame(dt) {
    if (lost) return;
    resize();
    // Idle drifts slowly; a live run spins the graph up. The difference is
    // meant to be readable from across a room.
    spin += dt * (0.05 + pulse * 0.55);
    pulse = Math.max(0, pulse - dt * 0.55);

    let links = 0;
    for (let i = 0; i < NODE_COUNT; i++) {
      const n = nodes[i];
      n.x += n.vx; n.y += n.vy; n.z += n.vz;
      if (Math.abs(n.x) > 13) n.vx *= -1;
      if (Math.abs(n.y) > 7.5) n.vy *= -1;
      if (Math.abs(n.z) > 8) n.vz *= -1;
      n.energy = Math.max(0, n.energy - dt * 0.9);
      pointPos[i * 3] = n.x; pointPos[i * 3 + 1] = n.y; pointPos[i * 3 + 2] = n.z;
      pointEnergy[i] = n.energy;
    }
    for (let i = 0; i < NODE_COUNT && links < MAX_LINKS; i++) {
      for (let j = i + 1; j < NODE_COUNT && links < MAX_LINKS; j++) {
        const a = nodes[i], b = nodes[j];
        const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
        if (dx * dx + dy * dy + dz * dz > LINK_DISTANCE * LINK_DISTANCE) continue;
        const o = links * 6;
        linkPos[o] = a.x; linkPos[o + 1] = a.y; linkPos[o + 2] = a.z;
        linkPos[o + 3] = b.x; linkPos[o + 4] = b.y; linkPos[o + 5] = b.z;
        linkEnergy[links * 2] = a.energy;
        linkEnergy[links * 2 + 1] = b.energy;
        links++;
      }
    }

    const aspect = canvas.width / Math.max(1, canvas.height);
    const mvp = multiply(
      perspective(Math.PI / 3.4, aspect, 0.1, 120),
      multiply(translation(0, 0, -21), multiply(rotationY(spin), rotationX(Math.sin(spin * 0.4) * 0.16))),
    );

    const accent = readVar('--accent', [0.18, 0.83, 0.75]);
    const hot = tone === 'error' ? readVar('--error', [0.95, 0.39, 0.49])
      : tone === 'warn' ? readVar('--warn', [0.9, 0.73, 0.33])
        : readVar('--info', [0.34, 0.71, 1.0]);

    const ground = readVar('--ground', [0.055, 0.063, 0.086]);
    gl.clearColor(ground[0], ground[1], ground[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniformMatrix4fv(loc.mvp, false, new Float32Array(mvp));
    gl.uniform3fv(loc.baseColor, new Float32Array(accent));
    gl.uniform3fv(loc.hotColor, new Float32Array(hot));

    // Edges first, so nodes sit on top of them.
    gl.bindBuffer(gl.ARRAY_BUFFER, linkPosBuf);
    gl.bufferData(gl.ARRAY_BUFFER, linkPos.subarray(0, links * 6), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(loc.position);
    gl.vertexAttribPointer(loc.position, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, linkEnergyBuf);
    gl.bufferData(gl.ARRAY_BUFFER, linkEnergy.subarray(0, links * 2), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(loc.energy);
    gl.vertexAttribPointer(loc.energy, 1, gl.FLOAT, false, 0, 0);
    gl.uniform1f(loc.alpha, 0.30);
    gl.uniform1f(loc.round, 0);
    gl.uniform1f(loc.pointScale, 1);
    gl.drawArrays(gl.LINES, 0, links * 2);

    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, pointPos, gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(loc.position, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, energyBuf);
    gl.bufferData(gl.ARRAY_BUFFER, pointEnergy, gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(loc.energy, 1, gl.FLOAT, false, 0, 0);
    gl.uniform1f(loc.alpha, 0.95);
    gl.uniform1f(loc.round, 1);
    gl.uniform1f(loc.pointScale, 6.5 * Math.min(window.devicePixelRatio || 1, 2));
    gl.drawArrays(gl.POINTS, 0, NODE_COUNT);
  }

  const scene = {
    frame,
    // Called from the event stream. `strength` lights nodes; `kind` picks the
    // colour the graph flashes.
    excite(strength, kind) {
      tone = kind || 'idle';
      pulse = Math.min(1, pulse + strength);
      const lit = Math.round(strength * 26) + 4;
      for (let i = 0; i < lit; i++) {
        nodes[Math.floor(Math.random() * NODE_COUNT)].energy = 1;
      }
    },
  };
  return scene;
}

// ── The harness client ───────────────────────────────────────────────────

const state = {
  events: [],
  approvals: [],
  taskId: '',
  sessionId: '',
  running: false,
  lastSeq: 0,
  gaps: 0,
};

const $ = (id) => document.getElementById(id);

function api(path, options) {
  return fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, options));
}

// The status words are the TUI's own vocabulary — ok / FAIL / .. / - / > — so
// someone who knows one front-end can read the other without relearning it.
const MARK = {
  'session.started': '-', 'task.created': '-', 'task.analyzed': '-', 'strategy.selected': '-',
  'task.started': '>', 'task.completed': 'ok', 'task.failed': 'FAIL', 'task.cancelled': 'FAIL',
  'agent.created': '-', 'agent.updated': '..', 'agent.completed': 'ok', 'agent.failed': 'FAIL',
  'model.requested': '..', 'model.responded': 'ok', 'model.failed': 'FAIL',
  'tool.requested': '..', 'tool.completed': 'ok', 'tool.failed': 'FAIL',
  'approval.requested': '>', 'approval.granted': 'ok', 'approval.denied': 'FAIL',
  'evaluation.completed': 'ok', 'repair.started': '..',
};

function toneOf(type) {
  if (type.endsWith('.failed') || type.endsWith('.cancelled') || type.endsWith('.denied')) return 'bad';
  if (type.startsWith('approval') || type.startsWith('repair')) return 'warn';
  if (type.endsWith('.completed') || type.endsWith('.responded') || type.endsWith('.granted')) return 'ok';
  if (type.endsWith('.requested') || type.endsWith('.updated') || type.endsWith('.started')) return 'busy';
  return '';
}

function summarise(e) {
  const d = e.data || {};
  if (d.message) return d.message;
  if (d.model) return d.model + (d.tokensOut ? ` · ${d.tokensOut} out` : '');
  if (d.tool) return d.tool;
  if (d.strategy) return d.strategy + (d.reason ? ` · ${d.reason}` : '');
  if (d.outcome) return `${d.evaluator || 'evaluator'} · ${d.outcome}`;
  if (d.prompt) return d.prompt;
  if (d.title) return d.title;
  if (d.status) return d.status;
  return '';
}

function clockOf(e) {
  const t = e.time ? new Date(e.time) : new Date();
  return isNaN(t) ? '' : t.toTimeString().slice(0, 8);
}

function renderEvents() {
  const stream = $('stream');
  const has = state.events.length > 0;
  $('empty').hidden = has;
  stream.hidden = !has;
  stream.innerHTML = '';
  for (const e of state.events.slice(-400)) {
    const row = document.createElement('div');
    row.className = 'ev ' + toneOf(e.type);
    for (const [cls, text] of [
      ['ev-t', clockOf(e)],
      ['ev-m', MARK[e.type] || '-'],
      ['ev-k', e.type],
      ['ev-d', summarise(e)],
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
    deny.textContent = 'Deny';
    deny.onclick = () => answer(a.id, false);
    const grant = document.createElement('button');
    grant.className = 'grant';
    grant.textContent = 'Approve';
    grant.onclick = () => answer(a.id, true);
    // Deny sits first so approve is never the button under the cursor by
    // accident; approving is the decision that deserves a deliberate move.
    actions.append(deny, grant);

    card.append(top, why, actions);
    box.append(card);
  }
}

async function answer(id, granted) {
  await api('/v1/approvals/' + encodeURIComponent(id), {
    method: 'POST',
    body: JSON.stringify({ granted }),
  });
  await refreshApprovals();
}

async function refreshApprovals() {
  try {
    const r = await api('/v1/approvals');
    const body = await r.json();
    state.approvals = body.approvals || [];
    renderApprovals();
  } catch { /* the stream brings it round again */ }
}

function setRun(title, sub, chipText, tone) {
  $('run-title').textContent = title;
  $('run-sub').textContent = sub;
  const chip = $('chip');
  chip.className = 'chip ' + (tone || '');
  chip.innerHTML = '';
  if (tone === 'busy') {
    const dot = document.createElement('span');
    dot.className = 'pulse';
    chip.append(dot);
  }
  chip.append(document.createTextNode(chipText));
}

async function refreshSessions() {
  try {
    const r = await api('/v1/sessions');
    const body = await r.json();
    const list = (body.sessions || []).slice(0, 40);
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
  } catch { /* the rail is not worth an error banner */ }
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
    const r = await api('/v1/tasks', {
      method: 'POST',
      body: JSON.stringify({ prompt, sessionId: state.sessionId || undefined }),
    });
    const body = await r.json();
    state.sessionId = body.sessionId || state.sessionId;
    const status = (body.task && body.task.status) || (body.error ? 'failed' : 'unknown');
    const detail = body.error ? String(body.error).slice(0, 120) : (state.taskId || '');
    setRun(prompt, detail, status, status === 'completed' ? 'ok' : 'bad');
  } catch {
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
  await api('/v1/tasks/' + encodeURIComponent(state.taskId) + '/cancel', { method: 'POST' });
}

function connectStream(scene) {
  const es = new EventSource('/v1/events');
  es.onopen = () => { $('link').textContent = 'live'; };
  es.onerror = () => { $('link').textContent = 'reconnecting'; };

  for (const type of Object.keys(MARK)) {
    es.addEventListener(type, (raw) => {
      let e;
      try { e = JSON.parse(raw.data); } catch { return; }
      e.type = type;

      // The SSE id is the bus publish counter. A gap means this client fell
      // behind and the server dropped events for it — worth saying out loud
      // rather than quietly showing an incomplete history.
      const seq = Number(raw.lastEventId || 0);
      if (state.lastSeq && seq > state.lastSeq + 1) {
        state.gaps += seq - state.lastSeq - 1;
        $('gaps').hidden = false;
        $('gaps').textContent = `${state.gaps} events dropped — this client fell behind`;
      }
      if (seq) state.lastSeq = seq;

      if (e.taskId) state.taskId = e.taskId;
      if (type.startsWith('approval.')) refreshApprovals();
      if (type === 'strategy.selected' && state.running) {
        setRun($('run-title').textContent, summarise(e), 'running', 'busy');
      }
      state.events.push(e);
      renderEvents();
      if (scene) {
        const tone = toneOf(type);
        scene.excite(type.startsWith('model') || type.startsWith('tool') ? 0.5 : 0.25,
          tone === 'bad' ? 'error' : tone === 'warn' ? 'warn' : 'idle');
      }
    });
  }
}

async function health() {
  try {
    const r = await api('/health');
    const h = await r.json();
    $('version').textContent = (h.version || '').replace(/^omniharness /, 'v');
    $('gw').textContent = h.omniroute ? 'connected' : 'unreachable';
    $('gw-dot').className = 'dot ' + (h.omniroute ? 'ok' : 'bad');
  } catch {
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
    setRun('Ready', 'nothing running', 'idle', '');
    refreshSessions();
    $('prompt').focus();
  };
  for (const chip of document.querySelectorAll('.suggest')) {
    chip.onclick = () => {
      $('prompt').value = chip.textContent;
      autosize();
      $('prompt').focus();
    };
  }
  $('prompt').addEventListener('input', autosize);
  $('prompt').addEventListener('keydown', (e) => {
    // Enter sends; Shift+Enter is a newline. The same bargain as the TUI.
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  });

  health();
  refreshApprovals();
  refreshSessions();
  connectStream(scene);
  setInterval(health, 15000);
  $('prompt').focus();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
