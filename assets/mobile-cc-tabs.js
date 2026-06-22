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

  // Best source = the CC transcript (the actual conversation). The daemon's
  // /api/cc-tab-summary resolves session → cwd → newest transcript and
  // returns the first + last user prompts. Returns null when there's no CC
  // transcript (non-CC shell, fresh session) → caller falls back to pane
  // text. Returns { context, src }.
  async function gatherContext(session) {
    // 1) Transcript (preferred).
    try {
      var r = await fetch('/api/cc-tab-summary?session=' + encodeURIComponent(session));
      if (r.ok) {
        var d = await r.json();
        if (d && d.found && (d.first || (d.recent && d.recent.length))) {
          var parts = [];
          if (d.first) parts.push('ORIGINAL TASK:\n' + d.first);
          if (d.recent && d.recent.length) {
            parts.push('RECENT REQUESTS (newest last):\n' +
              d.recent.map(function (x) { return '- ' + x; }).join('\n'));
          }
          return { context: parts.join('\n\n').slice(0, 3500), src: 'transcript' };
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
    'Given what the session is about, reply with a 3-5 word lowercase summary of the TASK being worked on.\n' +
    'Prefer a gerund phrase naming the concrete thing. No punctuation, no quotes, no preamble — ONLY the phrase.\n' +
    'Examples:\n' +
    '- fixing soft-keyboard popups\n' +
    '- ai tab subtitles\n' +
    '- refactoring auth flow\n' +
    '- debugging payment webhook\n' +
    '- writing release notes';

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
})();
