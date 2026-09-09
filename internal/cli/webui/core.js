// The client half of the harness front-ends, shared by both of them.
//
// There are two surfaces on this origin — the single-column web view at / and
// the desktop shell at /desktop — and they differ in layout, not in what the
// harness is. Everything that talks to the API, reads the event stream, or
// decides what an event *means* lives here, once. The views own pixels; this
// file owns facts.
//
// No modules, no bundler: it is a script tag that defines one global, which is
// the only arrangement that survives being embedded in a Go binary and served
// with no build step.

(function (root) {
  'use strict';

  // ── Talking to the server ──────────────────────────────────────────────

  function api(path, options) {
    return fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, options));
  }

  async function json(path, options) {
    const r = await api(path, options);
    return r.json();
  }

  // ── Reading an event ───────────────────────────────────────────────────

  // The status words are the TUI's own vocabulary — ok / FAIL / .. / - / > —
  // so someone who knows one front-end can read the other without relearning
  // it.
  //
  // Derived from the suffix rather than listed per type, because the list of
  // types lives in Go and grows there. A hand-maintained table here would
  // silently stop covering new events, which is the failure this whole file
  // was reorganised to end.
  const MARK_OVERRIDE = {
    'task.started': '>',
    'agent.started': '>',
    'approval.requested': '>',
    'session.started': '-',
    'session.ended': '-',
  };

  const OK_SUFFIX = ['.completed', '.responded', '.granted', '.saved'];
  const BAD_SUFFIX = ['.failed', '.cancelled', '.denied', '.lost', '.exceeded'];
  const BUSY_SUFFIX = ['.requested', '.started', '.updated', '.condensed', '.transcript'];

  function endsWithAny(s, list) {
    return list.some((suffix) => s.endsWith(suffix));
  }

  function markOf(type) {
    if (MARK_OVERRIDE[type]) return MARK_OVERRIDE[type];
    if (endsWithAny(type, OK_SUFFIX)) return 'ok';
    if (endsWithAny(type, BAD_SUFFIX)) return 'FAIL';
    if (endsWithAny(type, BUSY_SUFFIX)) return '..';
    return '-';
  }

  function toneOf(type) {
    if (endsWithAny(type, BAD_SUFFIX)) return 'bad';
    if (type.startsWith('approval.') || type.startsWith('repair.')) return 'warn';
    if (endsWithAny(type, OK_SUFFIX)) return 'ok';
    if (endsWithAny(type, BUSY_SUFFIX)) return 'busy';
    return '';
  }

  function summarise(e) {
    const d = e.data || {};
    if (d.message) return d.message;
    if (d.model) return d.model + (d.tokensOut ? ' · ' + d.tokensOut + ' out' : '');
    if (d.tool) return d.tool;
    if (d.strategy) return d.strategy + (d.reason ? ' · ' + d.reason : '');
    if (d.outcome) return (d.evaluator || 'evaluator') + ' · ' + d.outcome;
    if (d.error) return d.error;
    if (d.prompt) return d.prompt;
    if (d.title) return d.title;
    if (d.summary) return d.summary;
    if (d.status) return d.status;
    if (typeof d.tokensAfter === 'number') return d.tokensBefore + ' → ' + d.tokensAfter + ' tokens';
    return '';
  }

  function clockOf(e) {
    const t = e.time ? new Date(e.time) : new Date();
    return isNaN(t) ? '' : t.toTimeString().slice(0, 8);
  }

  // ── The event stream ───────────────────────────────────────────────────

  // SSE delivers named events, so a client only sees the types it registered a
  // listener for. Asking the server which types exist is not a convenience: an
  // unlistened type still consumes a Seq, so a client with a short list sees
  // the next event's id jump and concludes it fell behind. That is where the
  // "events dropped" warning came from on a run that dropped nothing.
  async function eventTypes() {
    try {
      const body = await json('/v1/event-types');
      if (Array.isArray(body.types) && body.types.length) return body.types;
    } catch (_) { /* fall through */ }
    // An older server, or none. Better a stream that carries the common types
    // than no stream at all — the gap counter is suppressed in that case, so
    // the incomplete list cannot masquerade as data loss.
    return null;
  }

  const FALLBACK_TYPES = [
    'session.started', 'task.created', 'task.analyzed', 'strategy.selected',
    'task.started', 'task.completed', 'task.failed', 'task.cancelled',
    'agent.created', 'agent.updated', 'agent.completed', 'agent.failed',
    'model.requested', 'model.responded', 'model.failed',
    'tool.requested', 'tool.completed', 'tool.failed',
    'approval.requested', 'approval.granted', 'approval.denied',
    'evaluation.completed', 'repair.started',
  ];

  // connect opens the stream and calls handlers as things happen.
  //
  //   onEvent(e)      one event, with .type filled in
  //   onLink(status)  'live' | 'reconnecting'
  //   onGap(count)    total events genuinely missed, only ever called when the
  //                   client is subscribed to the server's full vocabulary
  async function connect(handlers) {
    const types = await eventTypes();
    // Without the authoritative list any id jump is ambiguous, so gaps are not
    // reported at all. Silence is the honest answer; a warning would not be.
    const trustGaps = types !== null;
    const listen = types || FALLBACK_TYPES;

    const es = new EventSource('/v1/events');
    let lastSeq = 0;
    let gaps = 0;

    es.onopen = () => handlers.onLink && handlers.onLink('live');
    es.onerror = () => handlers.onLink && handlers.onLink('reconnecting');

    for (const type of listen) {
      es.addEventListener(type, (raw) => {
        let e;
        try { e = JSON.parse(raw.data); } catch (_) { return; }
        e.type = type;

        const seq = Number(raw.lastEventId || 0);
        if (trustGaps && lastSeq && seq > lastSeq + 1) {
          gaps += seq - lastSeq - 1;
          handlers.onGap && handlers.onGap(gaps);
        }
        if (seq) lastSeq = seq;

        handlers.onEvent && handlers.onEvent(e);
      });
    }
    return es;
  }

  // ── The rest of the API ────────────────────────────────────────────────

  async function health() {
    return json('/health');
  }

  async function sessions() {
    const body = await json('/v1/sessions');
    return body.sessions || [];
  }

  async function approvals() {
    const body = await json('/v1/approvals');
    return body.approvals || [];
  }

  async function answerApproval(id, granted) {
    return api('/v1/approvals/' + encodeURIComponent(id), {
      method: 'POST',
      body: JSON.stringify({ granted: granted }),
    });
  }

  async function run(prompt, sessionId) {
    return json('/v1/tasks', {
      method: 'POST',
      body: JSON.stringify({ prompt: prompt, sessionId: sessionId || undefined }),
    });
  }

  async function cancelTask(taskId) {
    return api('/v1/tasks/' + encodeURIComponent(taskId) + '/cancel', { method: 'POST' });
  }

  root.OH = {
    api: api,
    markOf: markOf,
    toneOf: toneOf,
    summarise: summarise,
    clockOf: clockOf,
    connect: connect,
    health: health,
    sessions: sessions,
    approvals: approvals,
    answerApproval: answerApproval,
    run: run,
    cancelTask: cancelTask,
  };
})(window);
