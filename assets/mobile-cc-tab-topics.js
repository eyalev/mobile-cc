// mobile-cc-tab-topics — surface a session's "recent topics" on the tab itself.
//
// Two surfaces, both opt-in via Settings → Tab Topics:
//   1. SUBTITLE SOURCE = "Recent topic": instead of the manual/✨ custom tag,
//      the tab subtitle shows the session's MOST RECENT topic — a short AI
//      summary of the latest Claude Code turn (auto-generated + cached via
//      Groq, throttled; raw prompt shown as a live placeholder while it
//      generates). Falls back to the custom label when there's no transcript
//      (plain shells), so non-CC tabs keep their manual subtitle.
//   2. ⋮ TAB MENU "Recent topics" section: a scrollable list of the session's
//      recent turns, injected into mobile-cc-tab-menu's ⋮ popover.
//
// Data comes from the SAME daemon endpoint as the full Topics panel
// (/api/cc-session-turns — see mobile-cc-topics.js + src/cc_search.rs); summary
// generation reuses the ttyview-stt-groq BYO key (Settings → Voice Input) and
// is browser-direct (Groq's API is CORS-open). Cached summaries are PUT back to
// the daemon so they persist (immutable, non-open turns only).
//
// Coordination-safe: NO upstream edits and NO edits to the sibling tab plugins
// (mobile-cc-tabs / mobile-cc-tab-menu, both under concurrent edit). The
// subtitle is DOM-injected over the upstream `.ttvtab-tag` (re-applied after
// each tab re-render, MutationObserver + interval backstop — same pattern as
// mobile-cc-tab-menu's ⋮). The menu section is injected by observing the
// `#mcc-tabmenu` popover appear.
(function () {
  var tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) return;
  if (window.__mccTabTopics) return;          // idempotent across re-evals
  window.__mccTabTopics = true;

  var SELF = tv.storage('mobile-cc-tab-topics');
  var GROQ_BASE = 'https://api.groq.com/openai/v1';
  var GROQ_MODEL = 'llama-3.3-70b-versatile';
  var TTL_MS = 25 * 1000;          // how long a cached topic is "fresh" (refetch cadence)
  var OPEN_THROTTLE_MS = 60 * 1000; // min gap between re-summarizing a still-open turn

  // tmux-web-style kind → accent (mirrors mobile-cc-topics.js).
  var KIND_COLOR = {
    feature: '#9ece6a', patch: '#7aa2f7', explore: '#bb9af7',
    ops: '#e0af68', discuss: '#7a88a0', work: '#7a88a0',
  };

  // ---- settings accessors -------------------------------------------
  function subtitleSource() { return SELF.get('subtitleSource') === 'topic' ? 'topic' : 'label'; }
  function menuTopicsOn() {
    var v = SELF.get('menuTopics');
    return (v === undefined || v === null) ? true : !!v;   // default ON
  }
  function groqKey() {
    try { return (tv.storage('ttyview-stt-groq').get('settings') || {}).groqKey || ''; }
    catch (_) { return ''; }
  }

  // ---- text helpers -------------------------------------------------
  function trimRaw(s, maxWords, maxChars) {
    s = (s || '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    var w = s.split(' ').slice(0, maxWords).join(' ');
    if (w.length > maxChars) return w.slice(0, maxChars - 1).replace(/\s+\S*$/, '') + '…';
    return w.length < s.length ? w + '…' : w;
  }

  // ---- topic cache + fetch + AI generation --------------------------
  // cache[session] = { ts, uuid, raw, summary, open }. Display = summary||raw.
  var cache = {};
  var fetching = {};
  var genAt = {};   // session → { uuid, ts } : last gen attempt (throttle the open turn)

  async function fetchLatest(session) {
    var r = await fetch('/api/cc-session-turns?session=' + encodeURIComponent(session) + '&limit=1');
    if (!r.ok) return null;
    var d = await r.json();
    if (!d || !d.found || !(d.turns || []).length) return null;
    return d.turns[d.turns.length - 1];      // server returns oldest→newest
  }
  async function genTurn(digest) {
    var key = groqKey();
    if (!key) throw new Error('no key');
    var sys = 'Summarize ONE turn of a Claude Code session in at most 8 words, lowercase, ' +
      'naming what was done (a gerund phrase). No punctuation, no quotes, ONLY the phrase.';
    var r = await fetch(GROQ_BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model: GROQ_MODEL, temperature: 0.3, max_tokens: 24,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: digest || '(empty)' }],
      }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var j = await r.json();
    var out = (((j.choices || [])[0] || {}).message || {}).content || '';
    return out.trim().replace(/^["'`]+|["'`.]+$/g, '').replace(/\s+/g, ' ').slice(0, 90);
  }
  function putSummary(session, uuid, summary) {
    fetch('/api/cc-session-turns', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: session, summaries: [{ uuid: uuid, summary: summary }] }),
    }).catch(function () {});
  }
  function canGen(session, t) {
    var g = genAt[session];
    if (!g) return true;
    if (g.uuid !== t.uuid) return true;                  // new turn → regen
    return (Date.now() - g.ts) > OPEN_THROTTLE_MS;       // same (open) turn → throttle
  }

  // Refresh a session's cached topic (and kick AI gen if needed). Cheap +
  // idempotent: a fresh cache short-circuits, and one fetch/gen is in flight
  // at a time per session.
  function ensureTopic(session, force) {
    var c = cache[session];
    if (!force && c && (Date.now() - c.ts) < TTL_MS) return;
    if (fetching[session]) return;
    fetching[session] = true;
    fetchLatest(session).then(function (t) {
      fetching[session] = false;
      if (!t) { cache[session] = { ts: Date.now(), uuid: null, raw: '', summary: '', open: false }; return; }
      var prev = cache[session] || {};
      // Preserve a locally-generated summary across refetches of the SAME
      // (still-open) turn so the subtitle doesn't flap back to the raw prompt.
      var keep = (prev.uuid === t.uuid) ? prev.summary : '';
      cache[session] = {
        ts: Date.now(), uuid: t.uuid,
        raw: trimRaw(t.user_text, 8, 44),
        summary: t.summary || keep || '',
        open: !!t.open,
      };
      paintTags();
      var cur = cache[session];
      if (!cur.summary && groqKey() && canGen(session, t)) {
        genAt[session] = { uuid: t.uuid, ts: Date.now() };
        genTurn(t.digest || t.user_text || '').then(function (s) {
          if (!s) return;
          var cc = cache[session];
          if (cc && cc.uuid === t.uuid) { cc.summary = s; paintTags(); }
          if (!t.open) putSummary(session, t.uuid, s);   // never cache the growing turn
        }).catch(function () {});
      }
    }).catch(function () { fetching[session] = false; });
  }

  // ---- subtitle injection (topic mode) ------------------------------
  function tallTabs() { return !!(document.body && document.body.classList.contains('ttv-tall-tabs')); }
  function visibleTabs() {
    return Array.prototype.filter.call(
      document.querySelectorAll('.ttvtab:not(.ttvtab-railbtn)'),
      function (t) { return !t.classList.contains('missing') && !t.classList.contains('ttvtab-add') && t.dataset.session; });
  }
  function paintTags() {
    if (subtitleSource() !== 'topic' || !tallTabs()) return;
    visibleTabs().forEach(function (t) {
      var session = t.dataset.session;
      var c = cache[session];
      if (!c) { ensureTopic(session); return; }   // no cache yet → fetch; leave native label as placeholder
      var topic = c.summary || c.raw;
      if (!topic) return;                          // no transcript → keep custom label fallback
      var tag = t.querySelector('.ttvtab-tag');
      if (!tag) { tag = document.createElement('span'); tag.className = 'ttvtab-tag'; t.appendChild(tag); }
      t.classList.add('has-tag');
      if (tag.getAttribute('data-mcc-topic') !== '1' || tag.textContent !== topic) {
        tag.textContent = topic;
        tag.title = topic;
        tag.setAttribute('data-mcc-topic', '1');
      }
    });
  }
  var paintPending = false;
  function schedulePaint() {
    if (paintPending) return; paintPending = true;
    var raf = window.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
    raf(function () { paintPending = false; paintTags(); });
  }

  // ---- ⋮ menu "Recent topics" section -------------------------------
  var pendingMenuSession = '';
  function el(tag, css, text) {
    var e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }
  // Small concurrency pool (mirrors mobile-cc-topics.js).
  async function pool(items, n, worker) {
    var i = 0;
    async function run() { while (i < items.length) { var k = i++; try { await worker(items[k], k); } catch (_) {} } }
    var runners = []; for (var c = 0; c < Math.min(n, items.length); c++) runners.push(run());
    await Promise.all(runners);
  }
  // The AI summary the TAB is currently showing for this turn (so the menu's
  // most-recent row matches the subtitle exactly — same string, no re-gen).
  function tabSummaryFor(session, t) {
    var c = cache[session];
    return (c && c.uuid === t.uuid && c.summary) ? c.summary : '';
  }
  // Replace a row's text while preserving the trailing "● open" badge.
  function setRowText(txtEl, text, open) {
    txtEl.textContent = text;
    txtEl.style.opacity = '1';
    if (open) txtEl.appendChild(el('span', 'color:#7aa2f7;font-size:10px;margin-left:6px;', '● open'));
  }

  async function injectMenuTopics(menu) {
    if (!menuTopicsOn()) return;
    var session = pendingMenuSession;
    if (!session || menu.querySelector('.mcc-menu-topics')) return;

    var sec = el('div', 'border-top:1px solid var(--ttv-border,#3a3a3a);margin-top:6px;padding-top:6px;');
    sec.className = 'mcc-menu-topics';
    sec.appendChild(el('div', 'padding:2px 12px 4px;color:var(--ttv-muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em;', 'Recent topics'));
    var list = el('div', 'max-height:190px;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;');
    sec.appendChild(list);
    var status = el('div', 'padding:6px 12px;color:var(--ttv-muted);font-size:12px;', 'Loading…');
    list.appendChild(status);
    menu.appendChild(sec);

    var d;
    try { d = await (await fetch('/api/cc-session-turns?session=' + encodeURIComponent(session) + '&limit=12')).json(); }
    catch (e) { status.textContent = 'Failed to load topics.'; return; }
    if (!d || !d.found) { status.textContent = 'No transcript yet.'; return; }
    var turns = (d.turns || []).slice().reverse();   // newest first
    if (!turns.length) { status.textContent = 'No turns yet.'; return; }
    list.removeChild(status);

    // Render each turn. Prefer the same AI summary the tab subtitle shows
    // (server cache → the tab's live summary for the open turn); fall back to
    // the raw prompt as a dim placeholder, then auto-summarize below so the
    // whole list reads as topics (in sync with the subtitle), not raw prompts.
    var nodes = turns.map(function (t) {
      var row = el('div', 'display:flex;align-items:flex-start;gap:8px;padding:6px 12px;');
      var dot = el('span', 'flex:none;width:7px;height:7px;border-radius:50%;margin-top:5px;background:' + (KIND_COLOR[t.kind] || '#7a88a0') + ';');
      row.appendChild(dot);
      var summary = t.summary || tabSummaryFor(session, t);
      var txt = el('div', 'color:var(--ttv-fg);font-size:12.5px;line-height:1.35;overflow-wrap:anywhere;');
      if (summary) { setRowText(txt, summary, t.open); }
      else { txt.style.opacity = '0.7'; setRowText(txt, trimRaw(t.user_text, 16, 90) || '(turn)', t.open); }
      row.appendChild(txt);
      list.appendChild(row);
      return { t: t, txt: txt, summarized: !!summary };
    });

    // Auto-summarize the uncached recent turns (cost-bounded), updating rows
    // live + caching non-open summaries on the daemon (shared with the Topics
    // panel). Keep the open/latest turn in sync with the tab's cache.
    if (!groqKey()) return;
    var latestUuid = turns[0] ? turns[0].uuid : null;
    var auto = nodes.filter(function (n) { return !n.summarized; }).slice(0, 8);
    await pool(auto, 3, async function (n) {
      var s = await genTurn(n.t.digest || n.t.user_text || '');
      if (!s) return;
      setRowText(n.txt, s, n.t.open);
      if (!n.t.open) putSummary(session, n.t.uuid, s);
      if (n.t.uuid === latestUuid) {                       // newest turn ⇒ keep subtitle in sync
        var c = cache[session];
        if (!c || c.uuid === n.t.uuid) {
          cache[session] = { ts: Date.now(), uuid: n.t.uuid, raw: trimRaw(n.t.user_text, 8, 44), summary: s, open: !!n.t.open };
          paintTags();
        }
      }
    });
  }

  // ---- observers / boot ---------------------------------------------
  // Capture the session whenever a ⋮ button is pressed, so we know which
  // session's topics to show when its popover appears.
  document.addEventListener('pointerdown', function (e) {
    var b = e.target && e.target.closest && e.target.closest('.mcc-tabmenu-btn');
    if (b) pendingMenuSession = b.getAttribute('data-session') || '';
  }, true);

  // In topic mode the per-tab custom label is dormant (the tab + Recent topics
  // show the AI topic instead), so mobile-cc-tab-menu's "tap to edit subtitle"
  // preview at the TOP of the ⋮ menu — which still shows that dormant label —
  // reads as inconsistent ("why is the top different?"). Hide it while topic
  // mode is on; it reappears in label mode and "Subtitle…" still edits it.
  function hideDormantLabelPreview(menu) {
    if (subtitleSource() !== 'topic') return;
    try {
      var prev = menu.querySelector('button[title="Tap to edit subtitle"]');
      if (prev) prev.style.display = 'none';
    } catch (_) {}
  }

  // Watch document.body for the ⋮ popover to appear, then graft topics in.
  function startMenuObserver() {
    if (!document.body) { document.addEventListener('DOMContentLoaded', startMenuObserver, { once: true }); return; }
    try {
      new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var added = muts[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var n = added[j];
            if (n.nodeType === 1 && n.id === 'mcc-tabmenu') { hideDormantLabelPreview(n); injectMenuTopics(n); }
          }
        }
      }).observe(document.body, { childList: true });
    } catch (_) {}
  }

  // Re-paint subtitle tags after the tab area re-renders (dot poll, output,
  // semantic events all trigger ttyview-tabs re-renders) + a slow backstop.
  function startTabObserver() {
    var tries = 0, attached = false;
    function attach() {
      var rail = document.querySelector('.ttvtab-rail');
      if (!rail) return false;
      schedulePaint();
      var host = rail.closest('[data-slot]') || rail.parentNode || document.body;
      try { new MutationObserver(schedulePaint).observe(host, { childList: true, subtree: true }); attached = true; } catch (_) {}
      return true;
    }
    var iv = setInterval(function () { if (attach() || ++tries > 60) clearInterval(iv); }, 250);
    attach();
    setInterval(function () { if (!attached) attach(); else schedulePaint(); }, 2000);
  }

  startMenuObserver();
  startTabObserver();
  tv.on('panes-updated', schedulePaint);
  tv.on('pane-changed', schedulePaint);
  tv.on('grid-loaded', schedulePaint);

  // Periodically refresh topics for the visible sessions (only in topic mode).
  setInterval(function () {
    if (subtitleSource() !== 'topic') return;
    var seen = {};
    visibleTabs().forEach(function (t) { var s = t.dataset.session; if (s && !seen[s]) { seen[s] = 1; ensureTopic(s); } });
  }, TTL_MS);

  // ---- Settings → Tab Topics ----------------------------------------
  if (tv.contributes && tv.contributes.settingsTab) {
    tv.contributes.settingsTab({
      id: 'mobile-cc-tab-topics',
      title: 'Tab Topics',
      render: function (container) {
        container.innerHTML = '';
        var intro = el('p', 'color:var(--ttv-muted);font-size:12px;margin:0 0 16px;line-height:1.45;',
          'Show each session\'s most recent topic — a short AI summary of its latest ' +
          'Claude Code turn — on the tab subtitle and in the tab ⋮ menu. Summaries use ' +
          'your Groq key (Settings → Voice Input); without a key, the raw latest prompt is shown.');
        container.appendChild(intro);

        // Subtitle source — segmented control.
        var srcWrap = el('div', 'margin-bottom:20px;');
        srcWrap.appendChild(el('div', 'font-size:13px;color:var(--ttv-fg);margin-bottom:6px;', 'Subtitle source'));
        var seg = el('div', 'display:flex;gap:6px;');
        var srcHint = el('div', 'color:var(--ttv-muted);font-size:11px;margin-top:8px;');
        var SRC = [
          { id: 'label', label: 'Custom label', hint: 'The manual / ✨ subtitle you set per tab.' },
          { id: 'topic', label: 'Recent topic', hint: 'Auto: the most recent topic, falling back to your custom label when a session has no transcript.' },
        ];
        function paintSeg() {
          var cur = subtitleSource();
          Array.prototype.forEach.call(seg.children, function (b) {
            var on = b.dataset.src === cur;
            b.style.background = on ? 'var(--ttv-accent,#E8896B)' : 'var(--ttv-bg-elev2,#2d2d30)';
            b.style.color = on ? '#1e1e1e' : 'var(--ttv-fg)';
            b.style.borderColor = on ? 'var(--ttv-accent,#E8896B)' : 'var(--ttv-border,#3a3a3a)';
          });
          var m = SRC.filter(function (x) { return x.id === cur; })[0];
          srcHint.textContent = m ? m.hint : '';
        }
        SRC.forEach(function (m) {
          var b = el('button', 'flex:1;min-width:0;height:38px;font-size:13px;border:1px solid var(--ttv-border,#3a3a3a);border-radius:8px;cursor:pointer;', m.label);
          b.type = 'button'; b.tabIndex = -1; b.dataset.src = m.id;
          b.addEventListener('mousedown', function (e) { e.preventDefault(); });
          b.addEventListener('click', function () {
            SELF.set('subtitleSource', m.id);
            paintSeg();
            if (m.id === 'topic') {
              visibleTabs().forEach(function (t) { ensureTopic(t.dataset.session, true); });
              schedulePaint();
            } else {
              // Restore native (label) rendering by forcing a full tab re-render.
              try { tv.refreshPanes(); } catch (_) {}
            }
          });
          seg.appendChild(b);
        });
        srcWrap.appendChild(seg);
        srcWrap.appendChild(srcHint);
        container.appendChild(srcWrap);
        paintSeg();

        // Toggle: topics in the ⋮ menu.
        var tRow = el('label', 'display:flex;align-items:center;gap:10px;color:var(--ttv-fg);font-size:14px;cursor:pointer;');
        var chk = document.createElement('input');
        chk.type = 'checkbox'; chk.checked = menuTopicsOn();
        chk.addEventListener('change', function () { SELF.set('menuTopics', chk.checked); });
        tRow.appendChild(chk);
        tRow.appendChild(document.createTextNode('Show “Recent topics” in the tab ⋮ menu'));
        container.appendChild(tRow);

        var note = el('div', 'color:var(--ttv-muted);font-size:11px;margin-top:8px;',
          'Topics come from your Claude Code transcripts (active session only). Plain shells with no transcript keep their custom subtitle.');
        container.appendChild(note);
      },
    });
  }
})();
