// mobile-cc-term-size — control how tall the terminal is, from a
// top-bar disclosure popover.
//
// The control is the tmux ROW COUNT. Tapping − resizes the active
// pane's tmux window to fewer rows (a {t:'resize'} sent on a dedicated
// WS — the same trick ttyview-kbd-diag uses; the daemon applies resize
// regardless of which socket sends it, via `resize-window -y rows`).
// The pane genuinely gets shorter, so you SEE ALL of it above the
// keyboard; the now-unused bottom of the flex:1 #grid-host shows as
// black space between the terminal content and the bottom controls —
// exactly the requested behavior, with no CSS height hacks.
//
// Width (cols) is preserved on every resize, so this coexists with the
// core autoFit (which only ever changes cols and preserves rows — so
// neither clobbers the other).
//
// UI: one disclosure button in the header keeps the crowded top bar
// lean. The popover groups all sizing controls — proxy buttons for the
// existing font A−/↔/A+ (so those can move out of the top bar) plus
// Rows −/[N]/+ and a reset.
//
// Target rows persist (mobile-cc-term-size.rows, global across panes)
// and re-apply on pane switch. Default is unset → the plugin touches
// nothing until you use it (safe to hot-seed onto a live session).
// Reset releases the manual-size lock (restore-size).
(function () {
  var tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) return;
  if (window.__mccTermSize) return;            // idempotent across re-evals
  window.__mccTermSize = true;

  var STORAGE = tv.storage('mobile-cc-term-size');
  var ROWS_KEY = 'rows';
  var STEP = 2, MIN = 6, MAX = 60;

  function targetRows() {
    var v = STORAGE.get(ROWS_KEY);
    return (typeof v === 'number' && v > 0) ? v : null;
  }
  function setTargetRows(n) { STORAGE.set(ROWS_KEY, n == null ? null : n); }

  function log(ev, data) {
    try { if (window.ttyviewLog) window.ttyviewLog('term-size-' + ev, data); } catch (_) {}
    try { console.log('[term-size]', ev, JSON.stringify(data || {})); } catch (_) {}
  }

  // ---- dedicated control WS (resize / restore-size) --------------
  var ws = null, sendQ = [];
  function wsUrl() { return (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws'; }
  function connect() {
    try {
      ws = new WebSocket(wsUrl());
      ws.addEventListener('open', function () { var q = sendQ.splice(0, sendQ.length); q.forEach(send); });
      ws.addEventListener('close', function () { ws = null; setTimeout(connect, 3000); });
      ws.addEventListener('error', function () { try { ws.close(); } catch (_) {} });
    } catch (_) { setTimeout(connect, 3000); }
  }
  function send(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) { sendQ.push(obj); return; }
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }
  connect();

  function applyRows(n) {
    var p = tv.getActivePane();
    if (!p || !p.id) { log('apply-skip', { reason: 'no-pane' }); return; }
    var cols = p.cols || 80;
    send({ t: 'resize', p: p.id, cols: cols, rows: n });
    log('apply', { pane: p.id, cols: cols, rows: n });
  }
  // Re-apply the target when switching panes (each pane is its own window).
  try {
    tv.on('pane-changed', function () {
      var n = targetRows();
      if (n != null) setTimeout(function () { applyRows(n); }, 150);
    });
  } catch (_) {}
  // Re-apply persisted target on load, once a pane + WS are ready.
  setTimeout(function () { var n = targetRows(); if (n != null) applyRows(n); }, 1200);

  // ---- popover ---------------------------------------------------
  var pop = null, outsideHandler = null;

  function currentRows() {
    var n = targetRows();
    if (n != null) return n;
    var p = tv.getActivePane();
    return (p && p.rows) ? p.rows : 0;
  }
  function renderReadout() {
    if (!pop) return;
    var r = pop.querySelector('#mcc-ts-n');
    if (r) r.textContent = currentRows() || '–';
  }
  function refreshSoon() {
    setTimeout(function () { try { tv.refreshPanes(); } catch (_) {} setTimeout(renderReadout, 200); }, 250);
  }

  function nudge(delta) {
    var base = currentRows() || 24;
    var n = Math.max(MIN, Math.min(MAX, base + delta));
    setTargetRows(n);
    applyRows(n);
    renderReadout();
    refreshSoon();
  }
  // "Normal" = the row count that fills the visible #grid-host at the
  // current font. We resize to that rather than `restore-size`, because
  // the page's own autoFit also holds a window-size-manual lock, so
  // releasing ours doesn't actually restore the window (it stays at the
  // last manual size). Resizing to the fill count is deterministic and
  // matches what the user means by "back to normal".
  function fillRows() {
    var gh = document.getElementById('grid-host');
    if (!gh) return null;
    var fs = parseFloat(getComputedStyle(gh).fontSize) || 12;
    var lineH = fs * 1.25;                 // matches #grid-host line-height
    var usable = gh.clientHeight - 8;      // ~4px top + 4px bottom padding
    var rows = Math.floor(usable / lineH);
    return Math.max(MIN, Math.min(MAX, rows));
  }
  function reset() {
    setTargetRows(null);
    var fill = fillRows();
    if (fill) applyRows(fill);
    renderReadout();
    refreshSoon();
  }
  function fontClick(id) { var b = document.getElementById(id); if (b) b.click(); }

  function mkBtn(label, title, onTap) {
    var b = document.createElement('button');
    b.type = 'button';
    b.tabIndex = -1;
    b.textContent = label;
    if (title) b.title = title;
    b.style.cssText =
      'min-width:34px;height:32px;padding:0 8px;border:1px solid var(--ttv-border,#3a3a3a);' +
      'border-radius:6px;background:transparent;color:var(--ttv-fg);font-size:14px;' +
      'cursor:pointer;font-family:inherit;line-height:1;';
    b.addEventListener('click', onTap);
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });
    return b;
  }
  function mkRow(labelText) {
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;margin:4px 0;';
    var lab = document.createElement('span');
    lab.textContent = labelText;
    lab.style.cssText = 'width:48px;flex:none;color:var(--ttv-muted);font-size:12px;';
    row.appendChild(lab);
    return row;
  }

  function buildPopover() {
    var el = document.createElement('div');
    el.id = 'mcc-term-popover';
    el.style.cssText =
      'position:fixed;z-index:1000;right:8px;top:48px;background:var(--ttv-bg-elev,#252526);' +
      'border:1px solid var(--ttv-border,#3a3a3a);border-radius:8px;padding:10px 12px;' +
      'box-shadow:0 6px 24px rgba(0,0,0,.45);';

    // Font row — proxy-clicks the existing (possibly hidden) header buttons,
    // so font controls can live here and be removed from the top bar.
    var fontRow = mkRow('Font');
    fontRow.appendChild(mkBtn('A−', 'Smaller font', function () { fontClick('font-down'); }));
    fontRow.appendChild(mkBtn('↔', 'Auto-fit', function () { fontClick('font-fit'); }));
    fontRow.appendChild(mkBtn('A+', 'Larger font', function () { fontClick('font-up'); }));
    el.appendChild(fontRow);

    // Rows row — the height control.
    var rowsRow = mkRow('Rows');
    rowsRow.appendChild(mkBtn('−', 'Shorter terminal', function () { nudge(-STEP); }));
    var n = document.createElement('span');
    n.id = 'mcc-ts-n';
    n.style.cssText = 'min-width:30px;text-align:center;color:var(--ttv-fg);font-size:14px;font-variant-numeric:tabular-nums;';
    rowsRow.appendChild(n);
    rowsRow.appendChild(mkBtn('+', 'Taller terminal', function () { nudge(STEP); }));
    rowsRow.appendChild(mkBtn('⟲', 'Reset to auto', function () { reset(); }));
    el.appendChild(rowsRow);

    return el;
  }

  function closePopover() {
    if (pop) { pop.remove(); pop = null; }
    if (outsideHandler) { document.removeEventListener('pointerdown', outsideHandler, true); outsideHandler = null; }
  }
  function openPopover(anchorBtn) {
    pop = buildPopover();
    document.body.appendChild(pop);
    renderReadout();
    // Close on tap outside (but not on the toggle button or popover itself).
    outsideHandler = function (e) {
      if (pop && !pop.contains(e.target) && e.target !== anchorBtn) closePopover();
    };
    setTimeout(function () { document.addEventListener('pointerdown', outsideHandler, true); }, 0);
  }

  tv.contributes.headerWidget({
    id: 'mobile-cc-term-size',
    name: 'Terminal size',
    preferredSlot: 'header-right',
    render: function (slot) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.title = 'Terminal size';
      btn.textContent = '⇕';
      btn.style.cssText = 'cursor:pointer;';
      btn.addEventListener('click', function () { if (pop) closePopover(); else openPopover(btn); });
      slot.appendChild(btn);
      return function unmount() { closePopover(); btn.remove(); };
    },
  });
})();
