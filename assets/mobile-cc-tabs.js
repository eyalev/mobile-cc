// mobile-cc-tabs — mobile-cc tab UX enhancements.
//
// Phase 1 (this file): opt into the tall two-line tab layout defined in
// ttyview-tabs.js (`body.ttv-tall-tabs`) so each tab shows its name on
// one line and its custom tag (subtitle — "what am I working on") on a
// readable second line, instead of cramming both into the stock 28px.
// Pair with the tabs setting maxPerRow=3 for enough width per tab.
//
// Phase 2 (added below once wired): define window.ttvTagSuggest so the
// inline tag editor shows a ✨ button that AI-generates the subtitle
// from the pane's recent output via Groq (reusing the ttyview-stt-groq
// BYO key). Kept here so all the Groq specifics stay out of upstream
// ttyview-tabs.js — that plugin only renders the button when the hook
// exists.
(function () {
  var tv = window.ttyview;
  if (!tv) return;
  if (window.__mccTabs) return;          // idempotent across re-evals
  window.__mccTabs = true;

  // ---- Phase 1: enable the tall two-line tab layout ----------------
  function enableTall() {
    try { document.body && document.body.classList.add('ttv-tall-tabs'); } catch (_) {}
  }
  enableTall();
  // body may not exist yet on the very first eval in some load orders.
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', enableTall, { once: true });
  }

  // ---- 3-tabs-per-row default (client-side, one-time) --------------
  // maxPerRow lives in the SYNCED ttyview-tabs storage, which is
  // client-authoritative — a server-side PUT gets clobbered when the
  // client re-syncs its localStorage. So seed it here (on the client),
  // once, guarded by our own flag, BEFORE ttyview-tabs reads its
  // settings (this plugin is ordered earlier in installed.json). After
  // the one-time seed the user can change per-row in Settings and it
  // sticks.
  var SELF = tv.storage('mobile-cc-tabs');
  try {
    if (!SELF.get('seededPerRow')) {
      var ts = tv.storage('ttyview-tabs');
      var s = ts.get('settings') || {};
      if (s.maxPerRow !== 3) { s.maxPerRow = 3; ts.set('settings', s); }
      SELF.set('seededPerRow', true);
    }
  } catch (_) {}

  // ---- migrate polluted subtitle keys (one-time, idempotent) -------
  // An earlier ⋮-menu bug saved subtitles under the tab's full title
  // ("mcc17 (press & hold to mark todo/done)") instead of the session
  // name, so they never rendered. Strip the trailing " (...)" hint and
  // merge onto the clean key. Harmless to run every load.
  try {
    var ls = tv.storage('ttyview-tabs');
    var labels = ls.get('labels');
    if (labels && typeof labels === 'object' && !Array.isArray(labels)) {
      var changed = false, out = {};
      Object.keys(labels).forEach(function (k) {
        var clean = k.replace(/\s+\(.*\)\s*$/, '');
        if (clean !== k) changed = true;
        if (clean && out[clean] == null) out[clean] = labels[k];
      });
      if (changed) ls.set('labels', out);
    }
  } catch (_) {}

  // ---- Phase 2: AI subtitle generator (window.ttvTagSuggest) --------
  // Reuses the ttyview-stt-groq BYO key (Settings → Voice Input). Grabs
  // the session's recent pane output and asks Groq's llama-3.3-70b for a
  // 3-5 word summary of what the session is working on. The ⋮ tab menu
  // (mobile-cc-tab-menu) renders a ✨ button only when this hook exists.
  // Groq's API is CORS-open (same as the stt-groq cleanup call), so this
  // runs browser-direct — no daemon endpoint.
  var GROQ_BASE = 'https://api.groq.com/openai/v1';
  var GROQ_MODEL = 'llama-3.3-70b-versatile';

  // How many latest user prompts the AI summarizes from. Adjustable in
  // Settings → Tab Subtitles. Stored in this plugin's scoped storage.
  var SELF_STORE = tv.storage('mobile-cc-tabs');
  var SUBTITLE_N_DEFAULT = 6;
  function subtitleN() {
    var v = parseInt(SELF_STORE.get('subtitleN'), 10);
    return (v >= 1 && v <= 20) ? v : SUBTITLE_N_DEFAULT;
  }

  // Best source = the CC transcript (the actual conversation). The daemon's
  // /api/cc-tab-summary resolves session → cwd → newest transcript and returns
  // the last N substantive user prompts (current focus; the original goal is
  // skipped — long sessions drift). Returns null when there's no CC transcript
  // (non-CC shell, fresh session) → caller falls back to pane text.
  async function gatherContext(session) {
    // 1) Transcript (preferred).
    try {
      var r = await fetch('/api/cc-tab-summary?session=' + encodeURIComponent(session) +
                          '&n=' + subtitleN());
      if (r.ok) {
        var d = await r.json();
        // New shape: d.prompts (last N). Back-compat: old server returned
        // d.first/d.recent — fold those in so a pre-bake preview still works.
        var ps = (d && d.prompts) || [];
        if ((!ps.length) && d) {
          if (d.recent && d.recent.length) ps = d.recent;
          else if (d.first) ps = [d.first];
        }
        if (d && d.found && ps.length) {
          // Goal anchor (first prompt) lets the model tell the session's
          // throughline apart from a recent detour. Skip it when it's also
          // the only/oldest recent so we don't print the same line twice.
          var goal = (d.first && d.first !== ps[0])
            ? 'SESSION GOAL (first request):\n- ' + d.first + '\n\n'
            : '';
          return {
            context: goal + 'RECENT REQUESTS (newest last):\n' +
              ps.map(function (x) { return '- ' + x; }).join('\n'),
            src: 'transcript',
          };
        }
      }
    } catch (_) {}
    // 2) Fallback: scrape the visible pane (non-CC shells).
    var panes = (tv.listPanes && tv.listPanes()) || [];
    var pane = panes.filter(function (p) { return p.session === session; })[0]
            || panes.filter(function (p) { return p.id === session; })[0];
    if (!pane) return null;
    var tr = await fetch('/panes/' + encodeURIComponent(pane.id) + '/text');
    if (!tr.ok) return null;
    var raw = await tr.text();
    var lines = raw.split('\n').map(function (x) { return x.replace(/\s+$/, ''); })
                   .filter(function (x) { return x.trim(); });
    var tail = lines.slice(-60).join('\n').slice(-4000);
    return tail ? { context: 'TERMINAL OUTPUT:\n' + tail, src: 'pane' } : null;
  }

  var SUBTITLE_SYS =
    'You write a SHORT label for a developer\'s Claude Code session tab, so they can tell tabs apart at a glance.\n' +
    'Reply with a 3-5 word lowercase gerund phrase naming the session\'s OVERALL throughline — the feature or\n' +
    'problem area it keeps returning to — NOT the most recent message.\n' +
    'IGNORE one-off detours, bug-fix tangents, and process/handoff messages (e.g. "commit", "hand it to X",\n' +
    '"solve with logs"). If the session is about building or designing something, prefer that over a momentary\n' +
    '"debugging" tangent.\n' +
    'No punctuation, no quotes, no preamble — ONLY the phrase.\n' +
    'Examples:\n' +
    '- fixing soft-keyboard popups\n' +
    '- refactoring auth flow\n' +
    '- writing release notes\n' +
    '- (mixed thread: research summary tools + a quick bug fix + a handoff) -> designing tab subtitles';

  window.ttvTagSuggest = async function (session) {
    var s = {};
    try { s = tv.storage('ttyview-stt-groq').get('settings') || {}; } catch (_) {}
    var key = s.groqKey;
    if (!key) throw new Error('No Groq key — add one in Settings → Voice Input');

    var ctx = await gatherContext(session);
    if (!ctx) throw new Error('No content for ' + session);

    var resp = await fetch(GROQ_BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.2,
        max_tokens: 20,
        messages: [
          { role: 'system', content: SUBTITLE_SYS },
          { role: 'user', content: 'Session "' + session + '".\n\n' + ctx.context },
        ],
      }),
    });
    if (!resp.ok) {
      var et = await resp.text().catch(function () { return ''; });
      throw new Error('Groq HTTP ' + resp.status + ' ' + et.slice(0, 120));
    }
    var j = await resp.json();
    var out = ((((j.choices || [])[0] || {}).message || {}).content || '')
      .trim().replace(/^["'`]+|["'`.]+$/g, '').replace(/\s+/g, ' ').toLowerCase();
    out = out.split(' ').slice(0, 5).join(' ').slice(0, 40);
    if (!out) throw new Error('empty summary');
    try { if (window.ttvDiag) window.ttvDiag('tag-suggest', { session: session, out: out, src: ctx.src }); } catch (_) {}
    return out;
  };

  // ---- Settings → Tab Subtitles (adjust how many prompts AI uses) ---
  if (tv.contributes && tv.contributes.settingsTab) {
    tv.contributes.settingsTab({
      id: 'mobile-cc-tabs',
      title: 'Tab Subtitles',
      render: function (container) {
        container.innerHTML = '';
        var intro = document.createElement('p');
        intro.style.cssText = 'color:var(--ttv-muted);font-size:12px;margin:0 0 16px;';
        intro.textContent =
          'When you ✨ Generate a tab subtitle, the AI reads your most recent ' +
          'prompts in that session. More prompts = broader context; fewer = ' +
          'tighter focus on what you are doing right now.';
        container.appendChild(intro);

        var row = document.createElement('label');
        row.style.cssText = 'display:flex;align-items:center;gap:12px;color:var(--ttv-fg);font-size:14px;';
        var span = document.createElement('span');
        span.textContent = 'Latest prompts to summarize';
        var num = document.createElement('input');
        num.type = 'number'; num.min = '1'; num.max = '20'; num.step = '1';
        num.value = String(subtitleN());
        num.style.cssText = 'width:64px;background:var(--ttv-bg,#1e1e1e);color:var(--ttv-fg);border:1px solid var(--ttv-border,#3a3a3a);border-radius:6px;padding:6px 8px;font:inherit;font-size:14px;';
        var range = document.createElement('input');
        range.type = 'range'; range.min = '1'; range.max = '20'; range.step = '1';
        range.value = String(subtitleN());
        range.style.cssText = 'flex:1;min-width:0;';
        function commit(v) {
          var n = Math.max(1, Math.min(20, parseInt(v, 10) || SUBTITLE_N_DEFAULT));
          num.value = String(n); range.value = String(n);
          SELF_STORE.set('subtitleN', n);
        }
        num.addEventListener('change', function () { commit(num.value); });
        range.addEventListener('input', function () { commit(range.value); });
        row.appendChild(span); row.appendChild(num);
        container.appendChild(row);
        container.appendChild(range);

        var hint = document.createElement('div');
        hint.style.cssText = 'color:var(--ttv-muted);font-size:11px;margin-top:8px;';
        hint.textContent = 'Default 6. cc-com messages and one-word replies (continue, yes…) are skipped automatically.';
        container.appendChild(hint);
      },
    });
  }
})();
