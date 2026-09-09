// The route view: what this session actually ran on, in three dimensions.
//
// This is not the decorative particle field the web view draws behind its
// reading column. Every node here is a real participant in this session — a
// model that answered, a tool that ran, an agent that asked — and every edge
// is a call that happened. A node grows when it is working and settles when it
// is done, so the motion is the run rather than an animation loop.
//
// Written against raw canvas with a hand-rolled perspective projection for the
// same reason as everything else in this directory: the binary ships one file
// and pulls nothing from a CDN.

function createRoute(canvas, labelLayer) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const nodes = new Map();   // id -> node
  const edges = new Map();   // "a|b" -> {a, b, count, hot}
  let spin = 0;
  let dpr = 1;

  const KIND_COLOUR = {
    agent: '--info',
    model: '--accent',
    tool: '--warn',
    task: '--ink-2',
  };

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
  }

  // Nodes are placed on a sphere by a deterministic hash of their id, so a
  // model keeps its position across redraws and between runs. A random layout
  // would reshuffle the picture every time an event arrived, which makes it
  // impossible to learn.
  //
  // Derived from the hash alone rather than from insertion order: a formula
  // that spaces nodes by index needs to know the final count, and a graph that
  // grows one node at a time does not have it — the first three nodes ended up
  // on top of each other, labels overlapping, which is what a viewer saw.
  function place(id) {
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h >>>= 0;
    // Two independent uniforms out of one hash, then the standard uniform
    // point on a sphere: z linear in [-1,1], theta around it.
    const u = (h % 4096) / 4096;
    const v = ((h >>> 12) % 4096) / 4096;
    const z = 2 * v - 1;
    const theta = 2 * Math.PI * u;
    const rho = Math.sqrt(Math.max(0, 1 - z * z));
    const r = 1.3;
    return {
      x: r * rho * Math.cos(theta),
      // Flattened a little: a wide, shallow cloud reads as a diagram, where a
      // full sphere reads as a screensaver.
      y: r * z * 0.66,
      z: r * rho * Math.sin(theta),
    };
  }

  function node(id, kind, label) {
    let n = nodes.get(id);
    if (!n) {
      const p = place(id);
      n = { id, kind, label: label || kind, x: p.x, y: p.y, z: p.z, heat: 0, live: false, calls: 0, el: null };
      nodes.set(id, n);
      if (labelLayer) {
        n.el = document.createElement('div');
        n.el.className = 'route-label ' + kind;
        n.el.textContent = n.label;
        labelLayer.append(n.el);
      }
    } else if (label && n.label !== label) {
      // A model span is opened by model.requested, which only knows the alias.
      // The real model arrives with the answer, so the label is corrected in
      // place rather than a second node appearing for the same call.
      n.label = label;
      n.kind = kind;
      if (n.el) { n.el.textContent = label; n.el.className = 'route-label ' + kind; }
    }
    return n;
  }

  function link(a, b) {
    if (!a || !b || a === b) return;
    const key = a.id + '|' + b.id;
    let e = edges.get(key);
    if (!e) { e = { a, b, count: 0, hot: 0 }; edges.set(key, e); }
    e.count++;
    e.hot = 1;
  }

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return false;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    return true;
  }

  function project(n, w, h) {
    const cos = Math.cos(spin), sin = Math.sin(spin);
    const x = n.x * cos - n.z * sin;
    const z = n.x * sin + n.z * cos;
    // A fixed camera distance of 3.2 with a 1.9 focal length: enough
    // perspective that depth reads, not so much that the far side warps.
    const depth = z + 3.2;
    const k = 1.9 / depth;
    const scale = Math.min(w, h) * 0.46;
    return { sx: w / 2 + x * k * scale, sy: h / 2 + n.y * k * scale, k, depth };
  }

  function frame(dt) {
    if (!resize()) return;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    // Slow enough to read a label as it comes round; a fast spin is a
    // screensaver, not a diagram.
    spin += dt * 0.16;

    const points = [];
    for (const n of nodes.values()) {
      const p = project(n, w, h);
      points.push([n, p]);
      n.heat = n.live ? Math.min(1, n.heat + dt * 3) : Math.max(0, n.heat - dt * 1.1);
    }
    // Painter's algorithm: far nodes first, so a near node overlaps rather
    // than being overlapped by whatever happened to be drawn later.
    points.sort((a, b) => b[1].depth - a[1].depth);

    const line = cssVar('--line');
    for (const e of edges.values()) {
      const pa = project(e.a, w, h), pb = project(e.b, w, h);
      e.hot = Math.max(0, e.hot - dt * 0.8);
      ctx.strokeStyle = e.hot > 0 ? cssVar('--accent') : line;
      ctx.globalAlpha = 0.18 + 0.5 * e.hot;
      ctx.lineWidth = (1 + 1.4 * e.hot) * dpr;
      ctx.beginPath();
      ctx.moveTo(pa.sx, pa.sy);
      ctx.lineTo(pb.sx, pb.sy);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    for (const [n, p] of points) {
      const colour = cssVar(KIND_COLOUR[n.kind] || '--ink-3');
      const r = (3.4 + 3.2 * n.heat) * p.k * dpr * 2.2;
      ctx.fillStyle = colour;
      ctx.globalAlpha = 0.35 + 0.65 * Math.min(1, p.k / 0.8);
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, Math.max(1.5 * dpr, r), 0, Math.PI * 2);
      ctx.fill();
      if (n.heat > 0.02) {
        ctx.globalAlpha = 0.25 * n.heat;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, Math.max(2 * dpr, r * 2.1), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      if (n.el) {
        // Labels are HTML rather than canvas text so they inherit the page's
        // font stack and stay selectable.
        n.el.style.transform = 'translate(' + (p.sx / dpr) + 'px,' + (p.sy / dpr - 16) + 'px) translateX(-50%)';
        n.el.style.opacity = String(Math.max(0.25, Math.min(1, (p.k - 0.4) * 2.6)));
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
    // ingest is fed the same span stream the timeline draws, so the two panes
    // can never disagree about what ran.
    // A node is identified by the step it belongs to, never by its label. The
    // label of a model step changes when the alias resolves, and keying on it
    // meant the resolved name arrived as a *second* node beside the alias —
    // one call drawn as two participants.
    open(span) {
      // No fallback label here on purpose: a model step knows its agent's id
      // but not its role, and passing a generic "agent" overwrote the real
      // name the agent step had already set.
      const agent = span.agentId ? node('agent:' + span.agentId, 'agent', span.agentLabel) : null;
      if (span.kind === 'model' || span.kind === 'tool') {
        const n = node(span.key, span.kind, span.nodeLabel);
        n.live = true;
        n.calls++;
        link(agent, n);
      } else if (agent) {
        agent.live = true;
      }
    },
    close(span) {
      if (span.kind === 'model' || span.kind === 'tool') {
        const n = node(span.key, span.kind, span.nodeLabel);
        n.live = false;
      } else if (span.agentId) {
        const a = nodes.get('agent:' + span.agentId);
        if (a) a.live = false;
      }
    },
  };
}
