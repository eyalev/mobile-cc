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

  var SELF = tv.storage('mobile-cc-tabs');

  // ---- Tab layout: subtitles on/off + per-mode height --------------
  // Two layout modes, each with its OWN height (Settings → Tab Layout):
  //   • WITH subtitles  → body.ttv-tall-tabs; name + (2-line-wrapped) subtitle.
  //   • WITHOUT         → body.mcc-no-subtitles; name only, compact.
  // Height is driven by our own vars with !important because upstream tall
  // mode HARD-CODES height:44px (ttyview-tabs.js), which silently overrode the
  // stock "Tab height" setting (the var it writes never won) — that's the
  // "changing tab height does nothing" bug. We override per-mode instead.
  var H_WITH_DEF = 60, H_WITHOUT_DEF = 30;
  function clampH(v, dflt) {
    var n = parseInt(v, 10);
    if (!isFinite(n)) n = dflt;
    return Math.max(20, Math.min(120, n));
  }
  function heightWith()    { return clampH(SELF.get('tabHeightWith'), H_WITH_DEF); }
  function heightWithout() { return clampH(SELF.get('tabHeightWithout'), H_WITHOUT_DEF); }
  function showSubsPref() {
    var v = SELF.get('showSubtitles');
    return (v === undefined || v === null) ? true : !!v;   // default ON
  }
  // How the subtitle text behaves when it's longer than the tab is wide:
  //   '2line'    → wrap to (up to) 2 lines, then clip   (default; original)
  //   'ellipsis' → single line, truncated with an ellipsis
  //   'scroll'   → single line, horizontally scrollable (swipe to read)
  function subtitleMode() {
    var v = SELF.get('subtitleMode');
    return (v === 'ellipsis' || v === 'scroll' || v === '2line') ? v : '2line';
  }
  function applyTabLayout() {
    var de = document.documentElement;
    de.style.setProperty('--mcc-tab-h-with', heightWith() + 'px');
    de.style.setProperty('--mcc-tab-h-without', heightWithout() + 'px');
    var b = document.body;
    if (!b) return;
    if (showSubsPref()) {
      b.classList.add('ttv-tall-tabs'); b.classList.remove('mcc-no-subtitles');
    } else {
      b.classList.remove('ttv-tall-tabs'); b.classList.add('mcc-no-subtitles');
    }
    b.classList.remove('mcc-sub-2line', 'mcc-sub-ellipsis', 'mcc-sub-scroll');
    b.classList.add('mcc-sub-' + subtitleMode());
    // Nudge ttyview-tabs to recompute its reserved-area height for the new
    // per-tab height (it relayouts on viewport resize).
    try { window.dispatchEvent(new Event('resize')); } catch (_) {}
  }

  // mcc-only style: subtitle wraps to 2 lines + left-aligned; per-mode tab
  // height (overrides upstream's hard-coded 44px); and the hide-subtitle mode.
  function injectLayoutStyle() {
    if (document.getElementById('mcc-tab-tag-wrap')) return;
    if (!document.head) return;
    var st = document.createElement('style');
    st.id = 'mcc-tab-tag-wrap';
    st.textContent =
      // Base: left-align the tag; per-mode rules below control wrap/clip/scroll.
      '.ttvtab:not(.ttvtab-railbtn) .ttvtab-tag{' +
        'text-align:left !important;overflow-wrap:anywhere;' +
      '}' +
      // 2-line (default): wrap up to 2 lines then clip.
      'body.mcc-sub-2line .ttvtab:not(.ttvtab-railbtn) .ttvtab-tag{' +
        'white-space:normal !important;' +
        'display:-webkit-box;-webkit-box-orient:vertical;' +
        '-webkit-line-clamp:2;line-clamp:2;' +
        'overflow:hidden;text-overflow:clip;' +
      '}' +
      // One line + ellipsis.
      'body.mcc-sub-ellipsis .ttvtab:not(.ttvtab-railbtn) .ttvtab-tag{' +
        'white-space:nowrap !important;display:block;' +
        'overflow:hidden;text-overflow:ellipsis;' +
      '}' +
      // One line, horizontally scrollable (hidden scrollbar; swipe to read).
      'body.mcc-sub-scroll .ttvtab:not(.ttvtab-railbtn) .ttvtab-tag{' +
        'white-space:nowrap !important;display:block;' +
        'overflow-x:auto;overflow-y:hidden;text-overflow:clip;' +
        '-webkit-overflow-scrolling:touch;scrollbar-width:none;' +
      '}' +
      'body.mcc-sub-scroll .ttvtab:not(.ttvtab-railbtn) .ttvtab-tag::-webkit-scrollbar{' +
        'height:0;width:0;display:none;' +
      '}' +
      '.ttvtab:not(.ttvtab-railbtn).has-tag .ttvtab-label{text-align:left !important;}' +
      // Keep the name row (name … dot ⋮) tight to its content instead of
      // growing to fill the tall tab. Upstream sets .ttvtab-head{flex:1 1 auto}
      // which, in mcc's taller 60px tabs, stretched the head and dropped a big
      // gap between the name row and the subtitle below. flex:none collapses the
      // head to one line height, so .has-tag's justify-content:center renders
      // the name-row + subtitle as one centered block separated only by the 2px
      // gap — and the ⋮ stays on the name row (align-items:center).
      'body.ttv-tall-tabs .ttvtab:not(.ttvtab-railbtn) .ttvtab-head{flex:0 0 auto !important;}' +
      // per-mode height — !important beats upstream's hard-coded height:44px
      'body.ttv-tall-tabs .ttvtab:not(.ttvtab-railbtn){height:var(--mcc-tab-h-with,60px) !important;}' +
      'body.mcc-no-subtitles .ttvtab:not(.ttvtab-railbtn){height:var(--mcc-tab-h-without,30px) !important;}' +
      // without-subtitles mode: hide the tag, revert to single-line name row
      'body.mcc-no-subtitles .ttvtab .ttvtab-tag{display:none !important;}' +
      'body.mcc-no-subtitles .ttvtab.has-tag{flex-direction:row !important;align-items:center !important;}';
    document.head.appendChild(st);
  }
  injectLayoutStyle();
  applyTabLayout();
  // body / head may not exist yet on the very first eval in some load orders.
  if (!document.body || !document.head) {
    document.addEventListener('DOMContentLoaded', function () {
      injectLayoutStyle(); applyTabLayout();
    }, { once: true });
  }

  // ---- 3-tabs-per-row default (client-side, one-time) --------------
  // maxPerRow lives in the SYNCED ttyview-tabs storage, which is
  // client-authoritative — a server-side PUT gets clobbered when the
  // client re-syncs its localStorage. So seed it here (on the client),
  // once, guarded by our own flag, BEFORE ttyview-tabs reads its
  // settings (this plugin is ordered earlier in installed.json). After
  // the one-time seed the user can change per-row in Settings and it
  // sticks.
  try {
    if (!SELF.get('seededPerRow')) {
      var ts = tv.storage('ttyview-tabs');
      var s = ts.get('settings') || {};
      if (s.maxPerRow !== 3) { s.maxPerRow = 3; ts.set('settings', s); }
      SELF.set('seededPerRow', true);
    }
  } catch (_) {}

  // ---- 2-row recents default (client-side, one-time) ---------------
  // Same client-authoritative-storage reasoning as the per-row seed
  // above: seed recentRows=2 once so a fresh mobile-cc visit shows the
  // recent strip as 2 wrapped rows scrolling vertically (the ttyview-tabs
  // upstream default stays 1 = single horizontal strip). User can change
  // it in Settings → Recent tabs afterward and it sticks.
  try {
    if (!SELF.get('seededRecentRows')) {
      var ts2 = tv.storage('ttyview-tabs');
      var s2 = ts2.get('settings') || {};
      if ((s2.recentRows | 0) < 2) { s2.recentRows = 2; ts2.set('settings', s2); }
      SELF.set('seededRecentRows', true);
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

    // ---- Settings → Tab Layout (subtitles on/off + per-mode height) ----
    tv.contributes.settingsTab({
      id: 'mobile-cc-tab-layout',
      title: 'Tab Layout',
      render: function (container) {
        container.innerHTML = '';
        var intro = document.createElement('p');
        intro.style.cssText = 'color:var(--ttv-muted);font-size:12px;margin:0 0 16px;';
        intro.textContent =
          'Choose whether tabs show their subtitle, and set the tab height for each ' +
          'mode independently. Changes apply immediately.';
        container.appendChild(intro);

        // Toggle: show subtitles
        var tRow = document.createElement('label');
        tRow.style.cssText = 'display:flex;align-items:center;gap:10px;color:var(--ttv-fg);font-size:14px;margin-bottom:18px;cursor:pointer;';
        var chk = document.createElement('input');
        chk.type = 'checkbox'; chk.checked = showSubsPref();
        chk.addEventListener('change', function () {
          SELF.set('showSubtitles', chk.checked);
          applyTabLayout();
          syncActive();
        });
        tRow.appendChild(chk);
        tRow.appendChild(document.createTextNode('Show subtitles on tabs'));
        container.appendChild(tRow);

        // Subtitle overflow mode — segmented control.
        var modeWrap = document.createElement('div');
        modeWrap.style.cssText = 'margin-bottom:18px;';
        var modeLbl = document.createElement('div');
        modeLbl.style.cssText = 'font-size:13px;color:var(--ttv-fg);margin-bottom:6px;';
        modeLbl.textContent = 'Long subtitle text';
        modeWrap.appendChild(modeLbl);
        var seg = document.createElement('div');
        seg.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
        var MODES = [
          { id: '2line',    label: 'Two lines',  hint: 'Wraps to up to 2 lines, then clips.' },
          { id: 'ellipsis', label: 'One line…',  hint: 'Single line, truncated with an ellipsis.' },
          { id: 'scroll',   label: 'Scroll →',   hint: 'Single line you can swipe sideways to read.' },
        ];
        var modeHint = document.createElement('div');
        modeHint.style.cssText = 'color:var(--ttv-muted);font-size:11px;margin-top:8px;';
        function paintSeg() {
          var cur = subtitleMode();
          Array.prototype.forEach.call(seg.children, function (b) {
            var on = b.dataset.mode === cur;
            b.style.background = on ? 'var(--ttv-accent,#E8896B)' : 'var(--ttv-bg-elev2,#2d2d30)';
            b.style.color = on ? '#1e1e1e' : 'var(--ttv-fg)';
            b.style.borderColor = on ? 'var(--ttv-accent,#E8896B)' : 'var(--ttv-border,#3a3a3a)';
          });
          var m = MODES.filter(function (x) { return x.id === cur; })[0];
          modeHint.textContent = m ? m.hint : '';
        }
        MODES.forEach(function (m) {
          var b = document.createElement('button');
          b.type = 'button'; b.tabIndex = -1; b.dataset.mode = m.id; b.textContent = m.label;
          b.style.cssText = 'flex:1;min-width:96px;height:38px;font-size:13px;border:1px solid var(--ttv-border,#3a3a3a);border-radius:8px;cursor:pointer;';
          b.addEventListener('mousedown', function (e) { e.preventDefault(); });
          b.addEventListener('click', function () {
            SELF.set('subtitleMode', m.id);
            applyTabLayout();
            paintSeg();
          });
          seg.appendChild(b);
        });
        modeWrap.appendChild(seg);
        modeWrap.appendChild(modeHint);
        container.appendChild(modeWrap);
        paintSeg();

        // A − / + stepper + number field. opts: {min,max,step,unit,after}.
        // `after` runs post-commit (height rows re-apply layout; the
        // tabs-per-row row schedules a reload — see below).
        function stepperRow(labelText, hintText, get, set, opts) {
          opts = opts || {};
          var lo = opts.min != null ? opts.min : 20;
          var hi = opts.max != null ? opts.max : 120;
          var step = opts.step || 2;
          var unitTxt = opts.unit != null ? opts.unit : 'px';
          var after = opts.after || applyTabLayout;
          function clampVal(v) {
            var n = parseInt(v, 10);
            if (!isFinite(n)) n = get();
            return Math.max(lo, Math.min(hi, n));
          }
          var wrap = document.createElement('div');
          wrap.style.cssText = 'margin-bottom:16px;';
          var lbl = document.createElement('div');
          lbl.style.cssText = 'font-size:13px;color:var(--ttv-fg);margin-bottom:4px;';
          lbl.textContent = labelText;
          wrap.appendChild(lbl);
          if (hintText) {
            var h = document.createElement('div');
            h.style.cssText = 'color:var(--ttv-muted);font-size:11px;margin-bottom:8px;';
            h.textContent = hintText;
            wrap.appendChild(h);
          }
          var ctl = document.createElement('div');
          ctl.style.cssText = 'display:flex;align-items:center;gap:8px;';
          function stepBtn(txt) {
            var b = document.createElement('button');
            b.type = 'button'; b.tabIndex = -1; b.textContent = txt;
            b.style.cssText = 'width:42px;height:42px;font-size:22px;line-height:1;background:var(--ttv-bg-elev2,#2d2d30);color:var(--ttv-fg);border:1px solid var(--ttv-border,#3a3a3a);border-radius:8px;cursor:pointer;';
            b.addEventListener('mousedown', function (e) { e.preventDefault(); });
            return b;
          }
          var minus = stepBtn('−');
          var num = document.createElement('input');
          num.type = 'number'; num.min = String(lo); num.max = String(hi); num.step = String(step);
          num.value = String(get());
          num.style.cssText = 'width:74px;height:42px;text-align:center;background:var(--ttv-bg,#1e1e1e);color:var(--ttv-fg);border:1px solid var(--ttv-border,#3a3a3a);border-radius:8px;font:inherit;font-size:15px;';
          var plus = stepBtn('+');
          function commit(v) {
            var n = clampVal(v);
            num.value = String(n);
            set(n);
            after();
          }
          minus.addEventListener('click', function () { commit(get() - step); });
          plus.addEventListener('click', function () { commit(get() + step); });
          num.addEventListener('change', function () { commit(num.value); });
          ctl.appendChild(minus); ctl.appendChild(num); ctl.appendChild(plus);
          if (unitTxt) {
            var unit = document.createElement('span');
            unit.textContent = unitTxt;
            unit.style.cssText = 'color:var(--ttv-muted);font-size:13px;';
            ctl.appendChild(unit);
          }
          wrap.appendChild(ctl);
          return wrap;
        }

        var withRow = stepperRow('Height with subtitles', 'Room for the name + up to 2 subtitle lines.',
          heightWith, function (n) { SELF.set('tabHeightWith', n); });
        var withoutRow = stepperRow('Height without subtitles', 'Compact — name only.',
          heightWithout, function (n) { SELF.set('tabHeightWithout', n); });
        container.appendChild(withRow);
        container.appendChild(withoutRow);

        // Tabs per row — lives in ttyview-tabs' synced settings (maxPerRow).
        // ttyview-tabs reads that into an in-memory copy at load and only
        // re-renders from it; there's no public live setter, so we persist
        // the value and (debounced) reload so the new row width takes effect.
        function perRowGet() {
          try {
            var s = tv.storage('ttyview-tabs').get('settings') || {};
            var v = parseInt(s.maxPerRow, 10);
            return (isFinite(v) && v > 0) ? v : 3;
          } catch (_) { return 3; }
        }
        function perRowSet(n) {
          try {
            var st = tv.storage('ttyview-tabs');
            var s = st.get('settings') || {};
            s.maxPerRow = n; st.set('settings', s);
          } catch (_) {}
        }
        var reloadTimer = null;
        function scheduleReload() {
          if (reloadTimer) clearTimeout(reloadTimer);
          perRowNote.textContent = 'Applying — the page will refresh…';
          reloadTimer = setTimeout(function () { try { location.reload(); } catch (_) {} }, 700);
        }
        var perRowRow = stepperRow('Tabs per row', 'How many tabs fit across each row.',
          perRowGet, perRowSet, { min: 1, max: 6, step: 1, unit: '', after: scheduleReload });
        container.appendChild(perRowRow);
        var perRowNote = document.createElement('div');
        perRowNote.style.cssText = 'color:var(--ttv-muted);font-size:11px;margin:-8px 0 16px;';
        perRowNote.textContent = 'Changing this refreshes the page to re-lay-out the tabs.';
        container.appendChild(perRowNote);

        // Visible rows = the pinned area's HEIGHT in tab-rows (ttyview-tabs
        // settings.rows). More tabs than fit scroll vertically within it.
        // Same in-memory-cache constraint as maxPerRow → persist + reload.
        function rowsGet() {
          try {
            var s = tv.storage('ttyview-tabs').get('settings') || {};
            var v = parseInt(s.rows, 10);
            return (isFinite(v) && v > 0) ? v : 4;
          } catch (_) { return 4; }
        }
        function rowsSet(n) {
          try {
            var st = tv.storage('ttyview-tabs');
            var s = st.get('settings') || {};
            s.rows = n; st.set('settings', s);
          } catch (_) {}
        }
        var rowsRow = stepperRow('Visible rows (pinned area height)',
          'How many tab-rows tall the pinned area is. Extra tabs scroll within it.',
          rowsGet, rowsSet, { min: 1, max: 8, step: 1, unit: 'rows', after: scheduleReload });
        container.appendChild(rowsRow);

        // Dim the height row that isn't the active mode (still editable).
        function syncActive() {
          var on = showSubsPref();
          modeWrap.style.opacity = on ? '1' : '0.45';
          withRow.style.opacity = on ? '1' : '0.45';
          withoutRow.style.opacity = on ? '0.45' : '1';
        }
        syncActive();
      },
    });
  }
})();
