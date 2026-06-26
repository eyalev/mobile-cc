// mobile-cc-prompt-nav — jump between YOUR OWN prompts in the terminal.
//
// The cell-grid (terminal) view has no message boundaries. But Claude Code's
// TUI marks every SUBMITTED user prompt with a left-edge glyph "❯ " (older
// builds: "> ") at the first cell of the row, while assistant/tool lines start
// with "● ". We detect those marker rows in the live DOM and a floating ▲/▼
// control smooth-scrolls #grid-host to the previous / next prompt row, with an
// N/M position pill + a brief highlight.
//
// (Per-prompt TIMESTAMPS are a separate, still-under-discussion feature — NOT
// built here. This plugin is navigation only.)
//
// Structural constraints (shared with mobile-cc-download): the grid reuses
// cell <span>s and rebuilds rows on every update, with NO stable per-row id.
// So we only ADD classes (never wrap), and re-scan to rebuild the marker list
// on grid-loaded / scrollback-prefill / pane-changed / resize / font-zoom + a
// debounced MutationObserver — the same re-overlay pattern download.js uses.
(function () {
  var tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) {
    console.warn('[mobile-cc-prompt-nav] requires apiVersion 1');
    return;
  }

  var NAV_ID = 'mcc-pn-nav';
  var FLASH_MS = 1100;

  function diag(cat, data) {
    try { if (typeof window.ttvDiag === 'function') window.ttvDiag(cat, data); } catch (e) {}
  }

  // markerRows: ordered top→bottom list of { el, text } for the current grid.
  var markerRows = [];
  var $pill = null;

  function injectStyle() {
    if (document.getElementById('mcc-pn-styles')) return;
    var s = document.createElement('style');
    s.id = 'mcc-pn-styles';
    s.textContent =
      '.ttv-row.mcc-pn-flash{background:color-mix(in srgb,var(--ttv-rail-accent,var(--ttv-accent,#E8896B)) 28%,transparent)!important;' +
        'transition:background-color 160ms;}' +
      // floating ▲/▼ control (bottom-right, thumb-reachable; ≥40px targets)
      '#' + NAV_ID + '{position:fixed;right:8px;bottom:120px;z-index:9500;display:none;' +
        'flex-direction:column;align-items:stretch;gap:2px;' +
        'background:var(--ttv-bg-elev2,#222);border:1px solid var(--ttv-border,#444);' +
        'border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.5);overflow:hidden;opacity:.92;}' +
      '#' + NAV_ID + '.on{display:flex;}' +
      '#' + NAV_ID + ' button{appearance:none;background:none;border:0;color:var(--ttv-fg,#eee);' +
        'width:44px;height:40px;font-size:17px;line-height:1;cursor:pointer;}' +
      '#' + NAV_ID + ' button:active{background:var(--ttv-bg-elev,#333);}' +
      '#' + NAV_ID + ' .mcc-pn-pill{font:600 11px system-ui,sans-serif;color:var(--ttv-muted,#9aa);' +
        'text-align:center;padding:2px 0;min-height:14px;}';
    document.head.appendChild(s);
  }

  // ---- marker detection (via the shared scanner) ------------------------
  // window.mccMarkers (mobile-cc-cc-markers.js) is the single source of truth
  // for '❯' user-prompt rows + chrome exclusion + SIGWINCH dedup — shared with
  // mobile-cc-turns. Resolved at call time so load order doesn't matter; we
  // simply skip a pass until it's present.
  function rescan() {
    var host = document.getElementById('grid-host');
    if (!host || !window.mccMarkers) { markerRows = []; updateNavVisibility(); return; }
    var users = window.mccMarkers.userMarkers(host);   // ordered, deduped, chrome-excluded
    markerRows = users.map(function (m) { return { el: m.el, text: m.post }; });
    if (navIdx >= markerRows.length) navIdx = markerRows.length - 1;
    updateNavVisibility();
    updatePill();
    diag('mcc-pn-scan', { prompts: markerRows.length });
  }

  // ---- navigation -------------------------------------------------------
  // navIdx/navAt: the prompt we last jumped to programmatically. While a jump
  // is recent (< STEP_MS), consecutive ▲/▼ taps STEP from it — so rapid taps
  // advance deterministically instead of re-reading an in-flight smooth-scroll
  // position. After it goes stale (or on manual scroll) we fall back to the
  // scroll position.
  var navIdx = -1, navAt = 0, STEP_MS = 700;
  function hostEl() { return document.getElementById('grid-host'); }
  // Index of the marker row nearest the current scroll top (for the pill).
  function nearestIdx() {
    var host = hostEl(); if (!host || !markerRows.length) return -1;
    var s = host.scrollTop, best = -1, bd = Infinity;
    for (var i = 0; i < markerRows.length; i++) {
      var d = Math.abs(markerRows[i].el.offsetTop - s);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  function flash(el) {
    el.classList.add('mcc-pn-flash');
    setTimeout(function () { el.classList.remove('mcc-pn-flash'); }, FLASH_MS);
  }
  function go(i) {
    if (i < 0 || i >= markerRows.length) return;
    var host = hostEl(); if (!host) return;
    var el = markerRows[i].el;
    host.scrollTo({ top: Math.max(0, el.offsetTop - 6), behavior: 'smooth' });
    flash(el);
    navIdx = i; navAt = Date.now();
    setPill(i);
    diag('mcc-pn-nav', { to: i, of: markerRows.length });
  }
  function freshBase() { return (navIdx >= 0 && (Date.now() - navAt) < STEP_MS) ? navIdx : -1; }
  function navDown() {
    if (!markerRows.length) return;
    var base = freshBase();
    if (base >= 0) { go(Math.min(markerRows.length - 1, base + 1)); return; }
    // position-based: first prompt strictly below the viewport top
    var host = hostEl(); var top = (host ? host.scrollTop : 0) + 6, target = -1;
    for (var i = 0; i < markerRows.length; i++) {
      if (markerRows[i].el.offsetTop > top) { target = i; break; }
    }
    go(target < 0 ? markerRows.length - 1 : target);
  }
  function navUp() {
    if (!markerRows.length) return;
    var base = freshBase();
    if (base >= 0) { go(Math.max(0, base - 1)); return; }
    // position-based: last prompt clearly above the viewport top
    var host = hostEl(); var top = (host ? host.scrollTop : 0) - 6, target = -1;
    for (var i = 0; i < markerRows.length; i++) {
      if (markerRows[i].el.offsetTop < top) target = i; else break;
    }
    go(target < 0 ? 0 : target);
  }

  function setPill(i) { if ($pill) $pill.textContent = markerRows.length ? (i + 1) + '/' + markerRows.length : ''; }
  // Manual-scroll pill sync: only when a programmatic jump isn't in flight, so
  // the scroll handler doesn't fight the step counter.
  function updatePill() { if (freshBase() >= 0) return; setPill(nearestIdx()); }
  function updateNavVisibility() {
    var nav = document.getElementById(NAV_ID);
    if (nav) nav.classList.toggle('on', markerRows.length > 0);
  }
  function buildNav() {
    if (document.getElementById(NAV_ID)) return;
    var nav = document.createElement('div');
    nav.id = NAV_ID;
    var up = document.createElement('button');
    up.type = 'button'; up.textContent = '▲'; up.tabIndex = -1;
    up.setAttribute('aria-label', 'Previous prompt');
    $pill = document.createElement('div'); $pill.className = 'mcc-pn-pill';
    var down = document.createElement('button');
    down.type = 'button'; down.textContent = '▼'; down.tabIndex = -1;
    down.setAttribute('aria-label', 'Next prompt');
    [up, down].forEach(function (b) { b.addEventListener('mousedown', function (e) { e.preventDefault(); }); });
    up.addEventListener('click', function (e) { e.preventDefault(); navUp(); });
    down.addEventListener('click', function (e) { e.preventDefault(); navDown(); });
    nav.appendChild(up); nav.appendChild($pill); nav.appendChild(down);
    document.body.appendChild(nav);
  }

  // ---- wiring -----------------------------------------------------------
  var scanT = null;
  function scheduleScan() { if (scanT) clearTimeout(scanT); scanT = setTimeout(rescan, 200); }

  function wire() {
    var host = document.getElementById('grid-host');
    if (!host) return false;
    new MutationObserver(function () { scheduleScan(); })
      .observe(host, { childList: true, subtree: true, characterData: true });
    return true;
  }

  injectStyle();
  buildNav();
  var tries = 0;
  var iv = setInterval(function () {
    if (wire() || ++tries > 60) { clearInterval(iv); rescan(); }
  }, 250);
  if (wire()) { clearInterval(iv); rescan(); }

  try { tv.on('grid-loaded', function () { scheduleScan(); }); } catch (e) {}
  try { tv.on('scrollback-prefill', function () { scheduleScan(); }); } catch (e) {}
  try { tv.on('pane-changed', function () { setTimeout(rescan, 60); }); } catch (e) {}
  window.addEventListener('resize', function () { scheduleScan(); });
  // Keep the pill in sync while the user scrolls the terminal by hand.
  (function () {
    var host = document.getElementById('grid-host');
    if (host) { var st = null; host.addEventListener('scroll', function () { if (st) clearTimeout(st); st = setTimeout(updatePill, 120); }, { passive: true }); }
  })();
  diag('mcc-pn-init', {});
})();
