// mobile-cc-kbd-diag — DIAGNOSTIC (temporary).
//
// Investigates: "sometimes switching tabs pops up the Android soft
// keyboard, not every time." The keyboard appears whenever an editable
// element (the Message textarea, or a contenteditable) receives focus
// inside a user gesture, OR when one is already focused and a relayout
// re-asserts it. This plugin instruments BOTH signals and correlates
// them with tab taps / pane switches, so the diag log shows *which*
// path is focusing the input.
//
// Output: JSONL into the daemon's diag log (~/.config/mobile-cc/
// diag.jsonl) via a dedicated same-origin WS (the page's ttvDiag isn't
// exposed to plugins, but the server accepts {t:'diag'} on any
// same-origin socket). Every record has cat starting "kbd-", so:
//   grep '"cat":"kbd-' ~/.config/mobile-cc/diag.jsonl | jq .
// Also mirrored to window.ttyviewLog (Settings → Client Logs) and the
// console, for on-device / remote-debug reading.
//
// Pure diagnostic — no UI, no behavior change. Remove once the cause is
// pinned (delete the file + its installed.json entry; no restart).
(function () {
  if (!window.ttyview) return;
  if (window.__mccKbdDiag) return;   // idempotent across re-evals
  window.__mccKbdDiag = true;

  var SEQ = 0;

  // ---- correlation markers ---------------------------------------
  // Stamped by the most recent tab tap / pane switch so a focus or
  // viewport event can report "how long ago did the user switch tabs".
  var lastTabTap   = null;  // { ts, label }
  var lastPaneChg  = null;  // { ts, from, to }
  var lastVV       = null;  // last visualViewport height we saw

  function now() {
    // performance.now() is monotonic; pair with wall ts for the log.
    try { return Math.round(performance.now()); } catch (_) { return 0; }
  }
  function wall() {
    // Date.now via a fresh Date is fine in the browser (the script-VM
    // Date ban is server-side only). Used so log readers don't have to
    // trust perf clocks.
    try { return Date.now(); } catch (_) { return 0; }
  }
  function since(mark) {
    if (!mark || mark.t == null) return null;
    return now() - mark.t;
  }

  // ---- editable detection ----------------------------------------
  function describe(el) {
    if (!el || el.nodeType !== 1) return null;
    var tag = (el.tagName || '').toLowerCase();
    var editable =
      tag === 'textarea' ||
      (tag === 'input' && !/^(button|submit|checkbox|radio|range|file|color|hidden)$/i.test(el.type || 'text')) ||
      el.isContentEditable === true;
    return {
      tag: tag + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''),
      editable: editable,
    };
  }

  // ---- diag shipper (own same-origin WS) -------------------------
  var buf = [];
  var ws = null;
  function wsUrl() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + '/ws';
  }
  function connect() {
    try {
      ws = new WebSocket(wsUrl());
      ws.addEventListener('open', flush);
      ws.addEventListener('close', function () { ws = null; setTimeout(connect, 2000); });
      ws.addEventListener('error', function () { try { ws.close(); } catch (_) {} });
    } catch (_) { setTimeout(connect, 2000); }
  }
  function flush() {
    if (!buf.length) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    var events = buf.splice(0, buf.length);
    try { ws.send(JSON.stringify({ t: 'diag', events: events })); }
    catch (_) { buf = events.concat(buf); }   // requeue on failure
  }
  setInterval(flush, 1000);
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
  connect();

  function emit(cat, data) {
    var rec = Object.assign({ cat: cat, ts: wall(), seq: ++SEQ }, data);
    buf.push(rec);
    if (buf.length >= 32) flush();
    try { if (window.ttyviewLog) window.ttyviewLog(cat, data); } catch (_) {}
    try { console.log('[' + cat + ']', JSON.stringify(data)); } catch (_) {}
  }

  // ---- tab-tap marker --------------------------------------------
  // Capture phase so we record the tap before ttyview-tabs' own
  // pointerup handler runs selectPane(). Match the tab rail by class.
  document.addEventListener('pointerup', function (e) {
    var t = e.target;
    var tab = t && t.closest && t.closest('.ttvtab, .ttvtab-head, .ttvtabs, .ttvtab-garrow');
    if (!tab) return;
    var label = (tab.textContent || '').trim().slice(0, 24);
    lastTabTap = { t: now() };
    emit('kbd-tab-tap', {
      label: label,
      cls: tab.className,
      pointerType: e.pointerType || null,
      vvH: vvHeight(),
      active: (describe(document.activeElement) || {}).tag || null,
    });
  }, true);

  // ---- pane-changed marker (fires for every tab switch) ----------
  try {
    window.ttyview.on('pane-changed', function (d) {
      lastPaneChg = { t: now() };
      emit('kbd-pane-changed', {
        from: (d && d.from) || null,
        to: (d && d.to) || null,
        sinceTabTap: since(lastTabTap),
        active: (describe(document.activeElement) || {}).tag || null,
      });
    });
  } catch (_) {}

  // ---- focus tracer ----------------------------------------------
  // The key signal: an editable element gaining focus. The stack
  // discriminates the cause:
  //   - programmatic el.focus()  → app frames present (synchronous).
  //   - native tap on the field  → stack is just this listener.
  document.addEventListener('focusin', function (e) {
    var d = describe(e.target);
    if (!d || !d.editable) return;
    var stack = '';
    try { stack = (new Error().stack || '').split('\n').slice(1, 9).map(function (s) { return s.trim(); }).join(' | '); } catch (_) {}
    emit('kbd-focus', {
      el: d.tag,
      sinceTabTap: since(lastTabTap),
      sincePaneChg: since(lastPaneChg),
      related: (describe(e.relatedTarget) || {}).tag || null,
      userActive: userActive(),
      vvH: vvHeight(),
      stack: stack,
    });
  }, true);

  document.addEventListener('focusout', function (e) {
    var d = describe(e.target);
    if (!d || !d.editable) return;
    emit('kbd-blur', { el: d.tag, sinceTabTap: since(lastTabTap), sincePaneChg: since(lastPaneChg) });
  }, true);

  // ---- viewport tracer (the keyboard actually opening) -----------
  // visualViewport height shrinks when the soft keyboard opens and
  // grows when it closes. This is the ground-truth "keyboard appeared"
  // signal, independent of whether a focusin fired. Threshold filters
  // out URL-bar / animation jitter.
  function vvHeight() {
    try { return window.visualViewport ? Math.round(window.visualViewport.height) : Math.round(window.innerHeight); }
    catch (_) { return null; }
  }
  function userActive() {
    try {
      if (navigator.userActivation) {
        return { active: navigator.userActivation.isActive, hasBeen: navigator.userActivation.hasBeenActive };
      }
    } catch (_) {}
    return null;
  }
  if (window.visualViewport) {
    lastVV = vvHeight();
    window.visualViewport.addEventListener('resize', function () {
      var h = vvHeight();
      var prev = lastVV;
      lastVV = h;
      if (prev == null || h == null) return;
      var delta = h - prev;
      if (Math.abs(delta) < 80) return;   // ignore small jitter
      emit('kbd-vv', {
        dir: delta < 0 ? 'shrink-keyboard-up' : 'grow-keyboard-down',
        delta: delta,
        height: h,
        sinceTabTap: since(lastTabTap),
        sincePaneChg: since(lastPaneChg),
        active: (describe(document.activeElement) || {}).tag || null,
      });
    });
  }

  emit('kbd-diag-installed', { vvH: vvHeight(), ua: (navigator.userAgent || '').slice(0, 80) });
})();
