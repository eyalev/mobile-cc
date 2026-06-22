// mobile-cc-download — long-press a file path in the terminal, tap ⬇ Download.
//
// Phase 1 of the "download a file from the terminal" feature: the robust,
// selection-driven path (a later phase adds one-tap auto-linkify over the
// grid cells). The cell-grid renders Claude Code's output as selectable
// `.ttv-cell` spans, so native long-press selection already works on Android.
// When the current selection (inside #grid-host) looks like a single path
// token, we float a ⬇ Download button next to it; tapping it hits the
// daemon's /api/download endpoint (allowlisted to $HOME server-side).
//
// Works in the plain PWA (Chrome downloads natively) AND the native Capacitor
// shell (where MainActivity wires a DownloadListener to Android's
// DownloadManager). Path reconstruction drops terminal soft-wrap newlines so
// a path wrapped across two rows still resolves.
(function () {
  var tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) {
    console.warn('[mobile-cc-download] requires apiVersion 1');
    return;
  }

  var BTN_ID = 'mcc-download-btn';

  function gridHost() { return document.getElementById('grid-host'); }

  // Return {sel, range} if there's a non-collapsed selection inside the grid.
  function selectionInGrid() {
    var sel = window.getSelection && window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    var host = gridHost();
    if (!host) return null;
    var range = sel.getRangeAt(0);
    var anc = range.commonAncestorContainer;
    var el = anc.nodeType === 1 ? anc : anc.parentNode;
    if (!el || !host.contains(el)) return null;
    return { sel: sel, range: range };
  }

  // Terminal soft-wrap inserts no real whitespace, so a path wrapped across
  // rows selects as "part1\npart2" — drop the newlines and trim the ends.
  function normalizePath(s) {
    return s.replace(/[\r\n]+/g, '').trim();
  }

  // Deliberately permissive (the user picked the text), but require a single
  // token with a slash so prose selections don't sprout a Download button.
  function looksLikePath(s) {
    if (!s || s.length > 4096) return false;
    if (/\s/.test(s)) return false;
    return s.charAt(0) === '~' || s.charAt(0) === '/' || s.indexOf('/') > 0;
  }

  function hideBtn() {
    var b = document.getElementById(BTN_ID);
    if (b) b.remove();
  }

  function basename(p) {
    var parts = p.split('/');
    return parts[parts.length - 1] || 'download';
  }

  function triggerDownload(path) {
    var url = '/api/download?path=' + encodeURIComponent(path);
    var a = document.createElement('a');
    a.href = url;
    a.download = basename(path);   // good filename in Android's DownloadManager
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); }, 0);
  }

  function showBtn(rect, path) {
    hideBtn();
    var b = document.createElement('button');
    b.id = BTN_ID;
    b.type = 'button';
    b.textContent = '⬇ Download';
    b.tabIndex = -1;
    // Below the selection — Android's native selection menu sits above it,
    // so this avoids overlap. Clamp into the viewport.
    var top = Math.min(window.innerHeight - 48, Math.round(rect.bottom) + 8);
    var left = Math.max(8, Math.min(window.innerWidth - 130, Math.round(rect.left)));
    b.style.cssText = [
      'position:fixed', 'z-index:99999',
      'left:' + left + 'px', 'top:' + top + 'px',
      'padding:8px 14px', 'border-radius:8px', 'border:none',
      'font:600 14px system-ui,sans-serif', 'color:#fff',
      'background:var(--ttv-accent,#E8896B)',
      'box-shadow:0 2px 8px rgba(0,0,0,.4)', 'cursor:pointer'
    ].join(';');
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });
    b.addEventListener('pointerup', function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      triggerDownload(path);
      hideBtn();
      try { window.getSelection().removeAllRanges(); } catch (_) {}
    });
    document.body.appendChild(b);
  }

  var t = null;
  function onSelChange() {
    if (t) clearTimeout(t);
    t = setTimeout(function () {
      var info = selectionInGrid();
      if (!info) { hideBtn(); return; }
      var path = normalizePath(info.sel.toString());
      if (!looksLikePath(path)) { hideBtn(); return; }
      var rect = info.range.getBoundingClientRect();
      if (!rect || (!rect.width && !rect.height)) { hideBtn(); return; }
      showBtn(rect, path);
    }, 120);
  }

  document.addEventListener('selectionchange', onSelChange);
  // The fixed-position button goes stale on scroll/resize — drop it.
  window.addEventListener('scroll', hideBtn, true);
  window.addEventListener('resize', hideBtn);
})();
