// mobile-cc-topics — per-session "Topics" (tmux-web style), MOBILE-SCOPED.
//
// Header  : a one-glance session summary (about + what happened) —
//           /api/cc-session-summary, cached.
// Timeline: tmux-web-style turn cards (one per user-turn) for the ACTIVE
//           session — /api/cc-session-turns. Each card shows a kind badge,
//           duration, files, error flag, and a one-line AI summary.
//
// Scope (user choice via AskUserQuestion; spec .claude/topics-feature-spec.md):
// active session only — NO cross-project populator, NO filters, NO background
// service. Generation is browser-direct via Groq (BYO key, same path as
// subtitles/STT). Cost guards: per-turn summaries are cached by turn UUID on
// the daemon (summarized once ever); we auto-summarize only the most recent
// turns on open, lazily summarize older ones on tap, and throttle the OPEN
// (still-growing) turn.
(function () {
  var tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) return;
  if (window.__mccTopics) return;
  window.__mccTopics = true;

  var GROQ_BASE = 'https://api.groq.com/openai/v1';
  var GROQ_MODEL = 'llama-3.3-70b-versatile';
  var AUTO_SUMMARIZE = 12;            // recent turns auto-summarized on open
  var OPEN_THROTTLE_MS = 60 * 1000;   // re-gen cap for the open turn
  var openGenCache = {};              // uuid → { ts, summary } (open-turn throttle)

  var KIND_COLOR = {
    feature: '#9ece6a', patch: '#7aa2f7', explore: '#bb9af7',
    ops: '#e0af68', discuss: '#7a88a0', work: '#7a88a0',
  };

  function groqKey() {
    try { return (tv.storage('ttyview-stt-groq').get('settings') || {}).groqKey || ''; }
    catch (_) { return ''; }
  }
  function activeSession() {
    var p = (tv.getActivePane && tv.getActivePane()) || null;
    return (p && p.session) ? p.session : null;
  }
  function fmtAgo(secs) {
    if (!secs) return '';
    var d = Math.max(0, Math.floor(Date.now() / 1000) - secs);
    if (d < 60) return 'just now';
    if (d < 3600) return Math.floor(d / 60) + 'm ago';
    if (d < 86400) return Math.floor(d / 3600) + 'h ago';
    return Math.floor(d / 86400) + 'd ago';
  }
  function fmtDur(ts, end) {
    try {
      var ms = new Date(end).getTime() - new Date(ts).getTime();
      if (!isFinite(ms) || ms < 0) return '';
      if (ms < 60000) return Math.round(ms / 1000) + 's';
      if (ms < 3600000) return Math.round(ms / 60000) + 'm';
      return Math.round(ms / 3600000) + 'h';
    } catch (_) { return ''; }
  }
  function el(tag, css, text) {
    var e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }

  // ---- panel ----
  var overlay = null;
  function closePanel() { if (overlay) { overlay.remove(); overlay = null; } }
  function openPanel() {
    closePanel();
    overlay = el('div', 'position:fixed;inset:0;z-index:1100;background:rgba(0,0,0,.5);display:flex;align-items:flex-start;justify-content:center;padding:40px 10px;');
    var modal = el('div', 'background:var(--ttv-bg-elev,#252526);border:1px solid var(--ttv-border,#3a3a3a);border-radius:10px;padding:14px;width:min(480px,95vw);max-height:84vh;overflow:auto;box-shadow:0 8px 32px rgba(0,0,0,.5);');
    overlay.appendChild(modal);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) closePanel(); });
    document.body.appendChild(overlay);
    return modal;
  }

  // ---- Groq generation ----
  async function groqJSON(messages, maxTokens, json) {
    var key = groqKey();
    if (!key) throw new Error('No Groq key — add one in Settings → Voice Input');
    var body = { model: GROQ_MODEL, temperature: 0.3, max_tokens: maxTokens, messages: messages };
    if (json) body.response_format = { type: 'json_object' };
    var r = await fetch(GROQ_BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify(body),
    });
    if (!r.ok) { var t = await r.text().catch(function () { return ''; }); throw new Error('Groq HTTP ' + r.status + ' ' + t.slice(0, 120)); }
    var j = await r.json();
    return (((j.choices || [])[0] || {}).message || {}).content || '';
  }
  async function genSummary(digest) {
    var sys = 'You summarize a developer\'s Claude Code session for a glanceable card. Return STRICT JSON {"about":"<one sentence>","did":["<3-5 concrete bullets>"]}. Terse, no markdown.';
    var raw = await groqJSON([{ role: 'system', content: sys }, { role: 'user', content: digest || '(empty)' }], 320, true);
    var o; try { o = JSON.parse(raw); } catch (_) { o = { about: raw.slice(0, 200), did: [] }; }
    return {
      about: (o.about || '').toString().trim(),
      did: Array.isArray(o.did) ? o.did.map(function (x) { return (x || '').toString().trim(); }).filter(Boolean).slice(0, 6) : [],
    };
  }
  async function genTurn(digest) {
    var sys = 'Summarize ONE turn of a Claude Code session in at most 9 words, lowercase, naming what was done (a gerund phrase). No punctuation, no quotes, ONLY the phrase.';
    var raw = await groqJSON([{ role: 'system', content: sys }, { role: 'user', content: digest || '(empty)' }], 24, false);
    return raw.trim().replace(/^["'`]+|["'`.]+$/g, '').replace(/\s+/g, ' ').slice(0, 90);
  }

  // Small concurrency pool.
  async function pool(items, n, worker) {
    var i = 0;
    async function run() { while (i < items.length) { var k = i++; try { await worker(items[k], k); } catch (_) {} } }
    var runners = []; for (var c = 0; c < Math.min(n, items.length); c++) runners.push(run());
    await Promise.all(runners);
  }

  // ---- session-summary header ----
  async function loadSummary(host, session, force) {
    host.innerHTML = '';
    var head = el('div', 'display:flex;align-items:center;gap:8px;margin-bottom:8px;');
    head.appendChild(el('h3', 'margin:0;font-size:16px;color:var(--ttv-fg);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', 'Summary · ' + session));
    var rf = el('button', 'flex:none;background:transparent;border:1px solid var(--ttv-border,#3a3a3a);border-radius:6px;color:var(--ttv-fg);font-size:15px;width:30px;height:30px;cursor:pointer;', '↻');
    rf.title = 'Regenerate summary'; rf.tabIndex = -1;
    rf.addEventListener('mousedown', function (e) { e.preventDefault(); });
    rf.addEventListener('click', function () { loadSummary(host, session, true); });
    head.appendChild(rf);
    host.appendChild(head);
    var body = el('p', 'margin:0 0 4px;color:var(--ttv-muted);font-size:13px;', force ? 'Regenerating…' : 'Loading…');
    host.appendChild(body);
    var d;
    try { d = await (await fetch('/api/cc-session-summary?session=' + encodeURIComponent(session) + (force ? '&force=1' : ''))).json(); }
    catch (e) { body.textContent = 'Summary failed: ' + e.message; body.style.color = '#e06c75'; return; }
    if (!d || !d.found) { body.textContent = 'No transcript yet.'; return; }
    if (!d.cached) {
      body.textContent = 'Summarizing…';
      try {
        var g = await genSummary(d.digest || '');
        d.about = g.about; d.did = g.did;
        fetch('/api/cc-session-summary', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: session, marker: d.marker, about: g.about, did: g.did, turns: d.turns || 0 }) }).catch(function () {});
      } catch (e) { body.textContent = e.message; body.style.color = '#e06c75'; return; }
    }
    host.removeChild(body);
    host.appendChild(el('p', 'margin:0 0 8px;color:var(--ttv-fg);font-size:14px;line-height:1.4;', d.about || '(no summary)'));
    if (d.did && d.did.length) {
      var ul = el('ul', 'margin:0 0 6px;padding-left:18px;color:var(--ttv-fg);font-size:13px;line-height:1.5;');
      d.did.forEach(function (x) { ul.appendChild(el('li', '', x)); });
      host.appendChild(ul);
    }
    host.appendChild(el('div', 'color:var(--ttv-muted);font-size:11px;', (d.turns ? d.turns + ' turns · ' : '') + (d.cached ? 'cached · ' + fmtAgo(d.generated_at) : 'fresh')));
  }

  // ---- turn card ----
  function turnCard(t) {
    var card = el('div', 'border:1px solid var(--ttv-border,#3a3a3a);border-radius:8px;padding:8px 10px;margin-bottom:8px;');
    var top = el('div', 'display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap;');
    var badge = el('span', 'flex:none;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:1px 6px;border-radius:4px;color:#1a1a1a;background:' + (KIND_COLOR[t.kind] || '#7a88a0') + ';', t.kind);
    top.appendChild(badge);
    var dur = fmtDur(t.ts, t.end_ts);
    if (dur) top.appendChild(el('span', 'color:var(--ttv-muted);font-size:11px;', dur));
    if (t.files && t.files.length) top.appendChild(el('span', 'color:var(--ttv-muted);font-size:11px;', t.files.length + (t.files.length === 1 ? ' file' : ' files')));
    if (t.has_errors) top.appendChild(el('span', 'color:#e06c75;font-size:11px;', '⚠ errors'));
    if (t.open) top.appendChild(el('span', 'color:#7aa2f7;font-size:11px;', '● open'));
    card.appendChild(top);

    var titleText = t.summary || t.user_text || '(turn)';
    var title = el('div', 'color:var(--ttv-fg);font-size:13px;line-height:1.4;', titleText);
    if (!t.summary) {
      // lazy: not yet AI-summarized → show user_text, tap to summarize.
      title.style.cursor = 'pointer';
      title.title = 'Tap to summarize';
      title.style.opacity = '0.85';
    }
    card.appendChild(title);

    if (t.files && t.files.length) {
      card.appendChild(el('div', 'color:var(--ttv-muted);font-size:11px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', t.files.join(' · ')));
    }
    if (t.commits && t.commits.length) {
      card.appendChild(el('div', 'color:var(--ttv-muted);font-size:11px;margin-top:2px;', '⎇ ' + t.commits.join(' ')));
    }
    return { card: card, title: title };
  }

  // ---- timeline ----
  async function loadTimeline(host, session, limit) {
    host.innerHTML = '';
    host.appendChild(el('div', 'color:var(--ttv-muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin:6px 0 8px;', 'Timeline'));
    var status = el('p', 'color:var(--ttv-muted);font-size:13px;', 'Loading turns…');
    host.appendChild(status);
    var d;
    try { d = await (await fetch('/api/cc-session-turns?session=' + encodeURIComponent(session) + '&limit=' + limit)).json(); }
    catch (e) { status.textContent = 'Turns failed: ' + e.message; status.style.color = '#e06c75'; return; }
    if (!d || !d.found) { status.textContent = 'No transcript yet.'; return; }
    var turns = d.turns || [];
    if (!turns.length) { status.textContent = 'No turns yet.'; return; }
    host.removeChild(status);

    // Render newest-first; keep a uuid→{title el, turn} map for live upgrade.
    var ordered = turns.slice().reverse();
    var nodes = {};
    ordered.forEach(function (t) { var c = turnCard(t); nodes[t.uuid] = { c: c, t: t }; host.appendChild(c.card); });

    // "Load older" if there are more turns than shown.
    if (d.total && d.total > turns.length) {
      var more = el('button', 'width:100%;background:transparent;border:1px dashed var(--ttv-border,#3a3a3a);border-radius:8px;color:var(--ttv-fg);font-size:13px;padding:8px;cursor:pointer;', 'Load older turns (' + (d.total - turns.length) + ' more)');
      more.tabIndex = -1;
      more.addEventListener('mousedown', function (e) { e.preventDefault(); });
      more.addEventListener('click', function () { loadTimeline(host, session, Math.min(100, limit + 20)); });
      host.appendChild(more);
    }

    // Tap-to-summarize for lazy (older / uncached) cards.
    Object.keys(nodes).forEach(function (uuid) {
      var n = nodes[uuid];
      if (n.t.summary) return;
      n.c.title.addEventListener('click', function () { summarizeOne(session, n); });
    });

    // Auto-summarize the most recent uncached turns (cost-bounded).
    var auto = ordered.filter(function (t) { return needsGen(t); }).slice(0, AUTO_SUMMARIZE);
    if (auto.length) {
      var done = [];
      await pool(auto, 3, async function (t) {
        try {
          var s = await genTurn(t.digest || t.user_text || '');
          if (!s) return;
          var n = nodes[t.uuid];
          if (n) { n.c.title.textContent = s; n.c.title.style.opacity = '1'; n.c.title.style.cursor = 'default'; n.t.summary = s; }
          if (!t.open) done.push({ uuid: t.uuid, summary: s });   // never cache the open (growing) turn
          else openGenCache[t.uuid] = { ts: Date.now(), summary: s };
        } catch (_) {}
      });
      if (done.length) {
        fetch('/api/cc-session-turns', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: session, summaries: done }) }).catch(function () {});
      }
    }
  }

  // Does this turn need (re)generation? Open turn honours the throttle.
  function needsGen(t) {
    if (t.summary) return false;
    if (t.open) {
      var c = openGenCache[t.uuid];
      if (c && (Date.now() - c.ts) < OPEN_THROTTLE_MS) { t.summary = c.summary; return false; }
      return true;
    }
    return true;
  }

  async function summarizeOne(session, n) {
    n.c.title.textContent = 'summarizing…'; n.c.title.style.opacity = '0.6';
    try {
      var s = await genTurn(n.t.digest || n.t.user_text || '');
      n.c.title.textContent = s || n.t.user_text; n.c.title.style.opacity = '1'; n.c.title.style.cursor = 'default'; n.t.summary = s;
      if (s && !n.t.open) fetch('/api/cc-session-turns', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: session, summaries: [{ uuid: n.t.uuid, summary: s }] }) }).catch(function () {});
    } catch (e) { n.c.title.textContent = n.t.user_text; n.c.title.style.opacity = '1'; }
  }

  function open() {
    var session = activeSession();
    if (!session) return;
    var modal = openPanel();
    var summaryHost = el('div', 'margin-bottom:6px;');
    var timelineHost = el('div', '');
    modal.appendChild(summaryHost);
    modal.appendChild(el('div', 'height:1px;background:var(--ttv-border,#3a3a3a);margin:8px 0;'));
    modal.appendChild(timelineHost);
    loadSummary(summaryHost, session, false);
    loadTimeline(timelineHost, session, 12);
  }

  tv.contributes.headerWidget({
    id: 'mobile-cc-topics',
    name: 'Session topics',
    preferredSlot: 'header-right',
    render: function (slot) {
      var btn = el('button', 'cursor:pointer;', '📋');
      btn.type = 'button'; btn.title = 'Session topics';
      btn.addEventListener('click', open);
      slot.appendChild(btn);
      return function unmount() { closePanel(); btn.remove(); };
    },
  });
})();
