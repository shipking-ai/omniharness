// The route view: what this session actually ran on, in three dimensions.
//
// This is not a decorative particle field. Every node is a real participant in
// this session — a model that answered, a tool that ran, the agent that asked —
// and every edge is a call that happened. A node glows while it is working and
// cools when it is done; a packet travels the edge for as long as the call is
// actually in flight. The motion is the run.
//
// Raw canvas with a hand-rolled perspective projection, for the same reason as
// everything else in this directory: the binary ships one file and pulls
// nothing from a CDN.

function createRoute(canvas, labelLayer) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const nodes = new Map();   // id -> node
  const edges = new Map();   // "a|b" -> edge
  let spin = 0;
  let dpr = 1;

  const KIND_COLOUR = { agent: '--info', model: '--accent', tool: '--warn' };

  // getComputedStyle on every node on every frame is a layout read per draw.
  // Resolved once and reused; the palette does not change at runtime.
  const palette = {};
  function cssVar(name) {
    if (palette[name] === undefined) {
      palette[name] = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
    }
    return palette[name];
  }

  // Nodes are placed on a sphere by a deterministic hash of their id, so a
  // model keeps its position across redraws and between runs. A random layout
  // would reshuffle the picture every time an event arrived, which makes it
  // impossible to learn.
  //
  // Derived from the hash alone rather than from insertion order: a formula
  // that spaces nodes by index needs the final count, and a graph that grows
  // one node at a time does not have it — the first few nodes landed on top of
  // each other with their labels overlapping.
  function place(id) {
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h >>>= 0;
    const u = (h % 4096) / 4096;
    const v = ((h >>> 12) % 4096) / 4096;
    const z = 2 * v - 1;
    const theta = 2 * Math.PI * u;
    const rho = Math.sqrt(Math.max(0, 1 - z * z));
    const r = 1.35;
    return {
      x: r * rho * Math.cos(theta),
      // Flattened: a wide shallow cloud reads as a diagram where a full sphere
      // reads as a screensaver.
      y: r * z * 0.6,
      z: r * rho * Math.sin(theta),
    };
  }

  function node(id, kind, label) {
    let n = nodes.get(id);
    if (!n) {
      const p = place(id);
      n = {
        id, kind, label: label || kind,
        x: p.x, y: p.y, z: p.z,
        heat: 0, live: false, calls: 0, born: performance.now(), el: null,
      };
      nodes.set(id, n);
      if (labelLayer) {
        n.el = document.createElement('div');
        n.el.className = 'route-label ' + kind;
        n.el.textContent = n.label;
        labelLayer.append(n.el);
      }
    } else if (label && n.label !== label) {
      // A model step is opened by model.requested, which knows only the alias.
      // The real model arrives with the answer, so the label is corrected in
      // place rather than a second node appearing for the same call.
      n.label = label;
      n.kind = kind;
      if (n.el) { n.el.textContent = label; n.el.className = 'route-label ' + kind; }
    }
    return n;
  }

  function link(a, b) {
    if (!a || !b || a === b) return null;
    const key = a.id + '|' + b.id;
    let e = edges.get(key);
    if (!e) { e = { a, b, count: 0, live: 0, phase: Math.random() }; edges.set(key, e); }
    e.count++;
    return e;
  }

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return false;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    return true;
  }

  function project(n, w, h) {
    const cos = Math.cos(spin), sin = Math.sin(spin);
    const x = n.x * cos - n.z * sin;
    const z = n.x * sin + n.z * cos;
    // Camera at 3.4 with a 2.0 focal length: enough perspective that depth
    // reads, not so much that the far side warps.
    const depth = z + 3.4;
    const k = 2.0 / depth;
    // Keyed off both axes rather than the short one. This pane is wide and
    // short, so Math.min(w,h) pinned the whole graph to a fraction of the
    // height and left the cloud stranded in the middle of a lot of empty
    // canvas.
    const scale = Math.min(w * 0.42, h * 0.8);
    return { sx: w / 2 + x * k * scale, sy: h / 2 + n.y * k * scale, k, depth };
  }

  // A node's disc plus the soft halo around it. Drawn with a radial gradient
  // rather than a blur filter: a filter on a canvas this size costs a
  // full-surface repaint per frame.
  function glow(p, colour, radius, strength) {
    const g = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, radius);
    g.addColorStop(0, colour);
    g.addColorStop(0.45, colour);
    g.addColorStop(1, 'transparent');
    ctx.globalAlpha = strength;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.sx, p.sy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  function frame(dt, now) {
    if (!resize()) return;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    // Slow enough to read a label as it comes round. A fast spin is a
    // screensaver, not a diagram.
    spin += dt * 0.14;

    const seen = [];
    for (const n of nodes.values()) {
      n.heat = n.live ? Math.min(1, n.heat + dt * 2.6) : Math.max(0, n.heat - dt * 1.0);
      seen.push([n, project(n, w, h)]);
    }
    // Painter's algorithm: far first, so a near node overlaps rather than
    // being overlapped by whatever happened to be drawn last.
    seen.sort((a, b) => b[1].depth - a[1].depth);

    const hair = cssVar('--line-strong');
    const accent = cssVar('--accent');

    for (const e of edges.values()) {
      const pa = project(e.a, w, h), pb = project(e.b, w, h);
      // A slight bow, so two edges between the same region stay tellable
      // apart and the graph does not read as a wire diagram.
      const mx = (pa.sx + pb.sx) / 2, my = (pa.sy + pb.sy) / 2;
      const dx = pb.sx - pa.sx, dy = pb.sy - pa.sy;
      const cx = mx - dy * 0.12, cy = my + dx * 0.12;

      ctx.strokeStyle = e.live > 0 ? accent : hair;
      ctx.globalAlpha = e.live > 0 ? 0.55 : 0.3;
      ctx.lineWidth = (e.live > 0 ? 1.6 : 1) * dpr;
      ctx.beginPath();
      ctx.moveTo(pa.sx, pa.sy);
      ctx.quadraticCurveTo(cx, cy, pb.sx, pb.sy);
      ctx.stroke();
      ctx.globalAlpha = 1;

      // While a call is genuinely in flight, a packet runs the edge. It stops
      // when the call returns, so a still edge means nothing is happening on
      // it — the motion is information, not decoration.
      if (e.live > 0) {
        const t = ((now / 1400) + e.phase) % 1;
        const it = 1 - t;
        const px = it * it * pa.sx + 2 * it * t * cx + t * t * pb.sx;
        const py = it * it * pa.sy + 2 * it * t * cy + t * t * pb.sy;
        glow({ sx: px, sy: py }, accent, 7 * dpr, 0.9);
      }
    }

    for (const [n, p] of seen) {
      const colour = cssVar(KIND_COLOUR[n.kind] || '--ink-3');
      // A node arriving scales up from 0.6 rather than from nothing; popping
      // in from zero reads as a glitch.
      const age = Math.min(1, (now - n.born) / 320);
      const grow = 0.6 + 0.4 * (1 - Math.pow(1 - age, 3));
      const r = (4.6 + 3.0 * n.heat) * p.k * dpr * 1.9 * grow;
      // Far nodes dim. Depth cueing is most of what makes a flat projection
      // read as three-dimensional at all.
      const near = Math.max(0.28, Math.min(1, (p.k - 0.35) * 2.2));

      if (n.heat > 0.01) glow(p, colour, r * 3.4, 0.16 * n.heat);
      ctx.globalAlpha = near;
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, Math.max(1.5 * dpr, r), 0, Math.PI * 2);
      ctx.fill();
      // A ring while live, so a working node is distinguishable in a still
      // screenshot and not only by its motion.
      if (n.heat > 0.02) {
        ctx.globalAlpha = 0.5 * n.heat * near;
        ctx.lineWidth = 1.2 * dpr;
        ctx.strokeStyle = colour;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, r + (4 + 3 * Math.sin(now / 420)) * dpr, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      if (n.el) {
        // Labels are HTML rather than canvas text so they inherit the page's
        // font stack and stay selectable.
        n.el.style.transform =
          'translate(' + (p.sx / dpr) + 'px,' + (p.sy / dpr) + 'px) translate(-50%,-' + (r / dpr + 13) + 'px)';
        n.el.style.opacity = String(near * (0.5 + 0.5 * age));
        n.el.classList.toggle('live', n.live);
      }
    }
  }

  function clear() {
    for (const n of nodes.values()) if (n.el) n.el.remove();
    nodes.clear();
    edges.clear();
  }

  return {
    frame,
    clear,
    count: () => nodes.size,
    // Fed the same step stream the timeline draws, so the two views can never
    // disagree about what ran.
    //
    // A node is identified by the step it belongs to, never by its label: the
    // label of a model step changes when the alias resolves, and keying on it
    // meant the resolved name arrived as a second node beside the alias — one
    // call drawn as two participants.
    open(step) {
      // No fallback label here on purpose. A model step knows its agent's id
      // but not its role, and passing a generic "agent" overwrote the real
      // name the agent step had already set.
      const agent = step.agentId ? node('agent:' + step.agentId, 'agent', step.agentLabel) : null;
      if (step.kind === 'model' || step.kind === 'tool') {
        const n = node(step.key, step.kind, step.nodeLabel);
        n.live = true;
        n.calls++;
        const e = link(agent, n);
        if (e) e.live++;
      } else if (agent) {
        agent.live = true;
      }
    },
    close(step) {
      if (step.kind === 'model' || step.kind === 'tool') {
        const n = node(step.key, step.kind, step.nodeLabel);
        n.live = false;
        for (const e of edges.values()) {
          if (e.b === n && e.live > 0) e.live--;
        }
      } else if (step.agentId) {
        const a = nodes.get('agent:' + step.agentId);
        if (a) a.live = false;
      }
    },
  };
}
