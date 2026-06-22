// mobile-cc-topics — per-session "Summary" (tmux-web-topics style): a
// glanceable card of what the ACTIVE session is about + what happened in it,
// so you don't have to scroll the transcript.
//
// Scope (decided with the user — see .claude/topics-feature-spec.md): SESSION
// summary only, ON-DEMAND + CACHED. No background populator, no cross-project
// mining. Generation is browser-direct via Groq (BYO key, same path as the
// subtitle/STT features — no server key plumbing). The daemon endpoint
// /api/cc-session-summary either returns a cached summary or a digest for us
// to summarize and POST back for caching (~/.cache/mobile-cc/topics).
(function () {
  var tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) return;
  if (window.__mccTopics) return;            // idempotent across re-evals
  window.__mccTopics = true;

  var GROQ_BASE = 'https://api.groq.com/openai/v1';
  var GROQ_MODEL = 'llama-3.3-70b-versatile';

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

  // ---- panel ----
  var overlay = null;
  function closePanel() { if (overlay) { overlay.remove(); overlay = null; } }
  function openPanel() {
    closePanel();
    overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:1100;background:rgba(0,0,0,.5);display:flex;align-items:flex-start;justify-content:center;padding:48px 12px;';
    var modal = document.createElement('div');
    modal.style.cssText = 'background:var(--ttv-bg-elev,#252526);border:1px solid var(--ttv-border,#3a3a3a);border-radius:10px;padding:16px;width:min(460px,94vw);max-height:80vh;overflow:auto;box-shadow:0 8px 32px rgba(0,0,0,.5);';
    overlay.appendChild(modal);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) closePanel(); });
    document.body.appendChild(overlay);
    return modal;
  }

  function header(modal, session, withRefresh) {
    var head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px;';
    var h = document.createElement('h3');
    h.textContent = 'Summary · ' + session;
    h.style.cssText = 'margin:0;font-size:16px;color:var(--ttv-fg);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    head.appendChild(h);
    if (withRefresh) {
      var refresh = document.createElement('button');
      refresh.type = 'button'; refresh.tabIndex = -1; refresh.textContent = '↻'; refresh.title = 'Regenerate';
      refresh.style.cssText = 'flex:none;background:transparent;border:1px solid var(--ttv-border,#3a3a3a);border-radius:6px;color:var(--ttv-fg);font-size:15px;width:32px;height:32px;cursor:pointer;';
      refresh.addEventListener('mousedown', function (e) { e.preventDefault(); });
      refresh.addEventListener('click', function () { load(modal, session, true); });
      head.appendChild(refresh);
    }
    modal.appendChild(head);
  }

  function renderLoading(modal, session, msg) {
    modal.innerHTML = '';
    header(modal, session, false);
    var p = document.createElement('p');
    p.textContent = msg || 'Loading…';
    p.style.cssText = 'color:var(--ttv-muted);font-size:13px;';
    modal.appendChild(p);
  }
  function renderError(modal, session, msg) {
    modal.innerHTML = '';
    header(modal, session, true);
    var p = document.createElement('p');
    p.textContent = msg;
    p.style.cssText = 'color:#e06c75;font-size:13px;';
    modal.appendChild(p);
  }
  function renderSummary(modal, session, data) {
    modal.innerHTML = '';
    header(modal, session, true);
    var about = document.createElement('p');
    about.textContent = data.about || '(no summary)';
    about.style.cssText = 'margin:0 0 12px;color:var(--ttv-fg);font-size:14px;line-height:1.4;';
    modal.appendChild(about);
    if (data.did && data.did.length) {
      var ul = document.createElement('ul');
      ul.style.cssText = 'margin:0 0 12px;padding-left:18px;color:var(--ttv-fg);font-size:13px;line-height:1.5;';
      data.did.forEach(function (d) { var li = document.createElement('li'); li.textContent = d; ul.appendChild(li); });
      modal.appendChild(ul);
    }
    var meta = document.createElement('div');
    meta.style.cssText = 'color:var(--ttv-muted);font-size:11px;';
    var bits = [];
    if (data.turns) bits.push(data.turns + ' turns');
    bits.push(data.cached ? ('cached · ' + fmtAgo(data.generated_at)) : 'fresh');
    meta.textContent = bits.join(' · ');
    modal.appendChild(meta);
  }

  async function generate(digest) {
    var key = groqKey();
    if (!key) throw new Error('No Groq key — add one in Settings → Voice Input');
    var sys =
      'You summarize a developer\'s Claude Code session for a glanceable "summary" card. ' +
      'Given the user prompts + key tool actions, return STRICT JSON: ' +
      '{"about":"<one sentence: what this session is about>","did":["<3-5 short concrete bullets of what happened / files touched>"]}. ' +
      'Be terse and concrete. No markdown, no extra keys.';
    var resp = await fetch(GROQ_BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model: GROQ_MODEL, temperature: 0.3, max_tokens: 320,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: digest || '(empty session)' },
        ],
      }),
    });
    if (!resp.ok) { var t = await resp.text().catch(function () { return ''; }); throw new Error('Groq HTTP ' + resp.status + ' ' + t.slice(0, 120)); }
    var j = await resp.json();
    var raw = (((j.choices || [])[0] || {}).message || {}).content || '{}';
    var obj; try { obj = JSON.parse(raw); } catch (_) { obj = { about: raw.slice(0, 200), did: [] }; }
    var about = (obj.about || '').toString().trim();
    var did = Array.isArray(obj.did)
      ? obj.did.map(function (x) { return (x || '').toString().trim(); }).filter(Boolean).slice(0, 6)
      : [];
    return { about: about, did: did };
  }

  async function load(modal, session, force) {
    renderLoading(modal, session, force ? 'Regenerating…' : 'Loading…');
    var d;
    try {
      var r = await fetch('/api/cc-session-summary?session=' + encodeURIComponent(session) + (force ? '&force=1' : ''));
      d = await r.json();
    } catch (e) { renderError(modal, session, 'Fetch failed: ' + e.message); return; }
    if (!d || !d.found) { renderError(modal, session, 'No Claude Code transcript for this session yet.'); return; }
    if (d.cached) { renderSummary(modal, session, d); return; }

    renderLoading(modal, session, 'Summarizing' + (d.turns ? ' ' + d.turns + ' turns' : '') + '…');
    var gen;
    try { gen = await generate(d.digest || ''); }
    catch (e) { renderError(modal, session, e.message); return; }
    renderSummary(modal, session, { about: gen.about, did: gen.did, turns: d.turns, cached: false, generated_at: Math.floor(Date.now() / 1000) });
    try {
      if (window.ttvDiag) window.ttvDiag('topics-gen', { session: session, did: gen.did.length });
    } catch (_) {}
    // Cache server-side so next open is instant (until the transcript grows).
    try {
      await fetch('/api/cc-session-summary', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: session, marker: d.marker, about: gen.about, did: gen.did, turns: d.turns || 0 }),
      });
    } catch (_) {}
  }

  tv.contributes.headerWidget({
    id: 'mobile-cc-topics',
    name: 'Session summary',
    preferredSlot: 'header-right',
    render: function (slot) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.title = 'Session summary';
      btn.textContent = '📋';
      btn.style.cssText = 'cursor:pointer;';
      btn.addEventListener('click', function () {
        var session = activeSession();
        if (!session) return;
        load(openPanel(), session, false);
      });
      slot.appendChild(btn);
      return function unmount() { closePanel(); btn.remove(); };
    },
  });
})();
