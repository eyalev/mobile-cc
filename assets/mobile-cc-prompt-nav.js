// mobile-cc-prompt-nav — jump between YOUR OWN prompts in the terminal, via a
// toolbar OUTLINE (replaces the old floating ▲/▼, which overlapped the right
// rail's +/grid/clock/pin/pencil icons).
//
// One toolbar button (headerWidget, near #scroll-bottom ↓) → a popover OUTLINE
// of the session's submitted prompts (post-'❯' text, natural reading order).
// Tap a row → smooth-scroll #grid-host to that prompt + highlight + close.
// ▲/▼ + N/M inside the popover step prev/next without closing. Dismiss on
// outside-tap / Esc. Reuses the shared scanner (window.mccMarkers).
//
// (Per-prompt TIMESTAMPS + role tint + turn separators live in the separate
// mobile-cc-turns "Message Regions" plugin — this is navigation only.)
(function () {
  var tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) {
    console.warn('[mobile-cc-prompt-nav] requires apiVersion 1');
    return;
  }

  var POP_ID = 'mcc-pn-pop';
  var FLASH_MS = 1100;
  var TRUNC = 56;

  function diag(cat, data) {
    try { if (typeof window.ttvDiag === 'function') window.ttvDiag(cat, data); } catch (e) {}
  }

  // markerRows: ordered top→bottom [{ el, text }] — refreshed each time the
  // outline opens (no persistent scanner needed now).
  var markerRows = [];
  var curIdx = -1;

  function injectStyle() {
    if (document.getElementById('mcc-pn-styles')) return;
    var s = document.createElement('style');
    s.id = 'mcc-pn-styles';
    s.textContent =
      '.ttv-row.mcc-pn-flash{background:color-mix(in srgb,var(--ttv-rail-accent,var(--ttv-accent,#E8896B)) 28%,transparent)!important;' +
        'transition:background-color 160ms;}' +
      '#mcc-pn-btn svg{display:block;width:18px;height:18px;}' +
      '#' + POP_ID + '{position:fixed;z-index:100000;display:flex;flex-direction:column;' +
        'min-width:230px;max-width:84vw;max-height:62vh;background:var(--ttv-bg-elev2,#222);' +
        'border:1px solid var(--ttv-border,#444);border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.5);overflow:hidden;}' +
      '#' + POP_ID + ' .mcc-pn-head{display:flex;align-items:center;gap:6px;padding:6px 8px;' +
        'border-bottom:1px solid var(--ttv-border,#3a3a3a);flex:none;}' +
      '#' + POP_ID + ' .mcc-pn-head button{appearance:none;background:none;border:0;color:var(--ttv-fg,#eee);' +
        'width:40px;height:34px;font-size:15px;cursor:pointer;border-radius:7px;}' +
      '#' + POP_ID + ' .mcc-pn-head button:active{background:var(--ttv-bg-elev,#333);}' +
      '#' + POP_ID + ' .mcc-pn-count{flex:1;text-align:center;font:600 12px system-ui,sans-serif;color:var(--ttv-muted,#9aa);}' +
      '#' + POP_ID + ' .mcc-pn-list{overflow-y:auto;-webkit-overflow-scrolling:touch;}' +
      '#' + POP_ID + ' .mcc-pn-item{display:block;width:100%;text-align:left;background:none;border:0;' +
        'border-bottom:1px solid var(--ttv-border,#2a2a2a);color:var(--ttv-fg,#eee);' +
        'font:400 14px system-ui,sans-serif;line-height:1.35;padding:10px 12px;cursor:pointer;white-space:normal;}' +
      '#' + POP_ID + ' .mcc-pn-item:active{background:var(--ttv-bg-elev,#333);}' +
      '#' + POP_ID + ' .mcc-pn-item.active{background:color-mix(in srgb,var(--ttv-accent,#569cd6) 18%,transparent);}' +
      '#' + POP_ID + ' .mcc-pn-item .mcc-pn-idx{color:var(--ttv-muted,#9aa);margin-right:8px;font-variant-numeric:tabular-nums;}' +
      '#' + POP_ID + ' .mcc-pn-item .mcc-pn-label{display:block;color:var(--ttv-muted,#9aa);font-size:12px;margin-top:2px;}' +
      '#' + POP_ID + ' .mcc-pn-empty{padding:16px 14px;color:var(--ttv-muted,#9aa);font:14px system-ui,sans-serif;}';
    document.head.appendChild(s);
  }

  // ---- scan + scroll ----------------------------------------------------
  function hostEl() { return document.getElementById('grid-host'); }
  function rescan() {
    var host = hostEl();
    if (!host || !window.mccMarkers) { markerRows = []; return; }
    markerRows = window.mccMarkers.userMarkers(host).map(function (m) { return { el: m.el, text: m.post }; });
    diag('mcc-pn-scan', { prompts: markerRows.length });
  }
  function nearestIdx() {
    var host = hostEl();
    if (!host || !markerRows.length) return 0;
    var s = host.scrollTop, best = 0, bd = Infinity;
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
    curIdx = i;
    diag('mcc-pn-nav', { to: i, of: markerRows.length });
  }

  // P2 HOOK: outline rows can later show an AI turn-summary label. A future
  // plugin sets window.mccPromptLabel = function(markerText, idx) -> string.
  function labelFor(text, idx) {
    try { if (typeof window.mccPromptLabel === 'function') return window.mccPromptLabel(text, idx) || ''; } catch (e) {}
    return '';
  }
  function truncate(t) {
    t = (t || '').replace(/\s+/g, ' ').trim();
    return t.length > TRUNC ? t.slice(0, TRUNC - 1) + '…' : t;
  }

  // ---- popover ----------------------------------------------------------
  var $pop = null, $count = null, $list = null, onKey = null;
  function closePop() {
    if ($pop) { $pop.remove(); $pop = null; }
    document.removeEventListener('pointerdown', onOutside, true);
    window.removeEventListener('resize', closePop);
    if (onKey) { document.removeEventListener('keydown', onKey, true); onKey = null; }
  }
  function onOutside(e) {
    if ($pop && !$pop.contains(e.target) && e.target.id !== 'mcc-pn-btn' &&
        !(e.target.closest && e.target.closest('#mcc-pn-btn'))) closePop();
  }
  function setActive(i) {
    if (!$list) return;
    var items = $list.children;
    for (var k = 0; k < items.length; k++) items[k].classList.toggle('active', k === i);
    if ($count) $count.textContent = markerRows.length ? (i + 1) + ' / ' + markerRows.length : '0';
    var it = items[i];
    if (it && it.scrollIntoView) it.scrollIntoView({ block: 'nearest' });
  }
  function step(d) {
    if (!markerRows.length) return;
    var i = Math.max(0, Math.min(markerRows.length - 1, (curIdx < 0 ? nearestIdx() : curIdx) + d));
    go(i); setActive(i);
  }
  function openPop(anchor) {
    closePop();
    rescan();
    curIdx = nearestIdx();
    $pop = document.createElement('div');
    $pop.id = POP_ID;
    $pop.setAttribute('role', 'dialog');
    $pop.setAttribute('aria-label', 'Prompt outline');

    var head = document.createElement('div'); head.className = 'mcc-pn-head';
    var up = document.createElement('button'); up.type = 'button'; up.textContent = '▲';
    up.tabIndex = -1; up.setAttribute('aria-label', 'Previous prompt');
    $count = document.createElement('div'); $count.className = 'mcc-pn-count';
    var down = document.createElement('button'); down.type = 'button'; down.textContent = '▼';
    down.tabIndex = -1; down.setAttribute('aria-label', 'Next prompt');
    [up, down].forEach(function (b) { b.addEventListener('mousedown', function (e) { e.preventDefault(); }); });
    up.addEventListener('click', function (e) { e.preventDefault(); step(-1); });
    down.addEventListener('click', function (e) { e.preventDefault(); step(1); });
    head.appendChild(up); head.appendChild($count); head.appendChild(down);
    $pop.appendChild(head);

    $list = document.createElement('div'); $list.className = 'mcc-pn-list';
    if (!markerRows.length) {
      var empty = document.createElement('div'); empty.className = 'mcc-pn-empty';
      empty.textContent = 'No prompts in view.';
      $list.appendChild(empty);
    } else {
      markerRows.forEach(function (m, i) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'mcc-pn-item'; b.tabIndex = -1;
        var idx = document.createElement('span'); idx.className = 'mcc-pn-idx'; idx.textContent = (i + 1) + '.';
        b.appendChild(idx);
        b.appendChild(document.createTextNode(truncate(m.text)));
        var lab = labelFor(m.text, i);
        if (lab) { var ls = document.createElement('span'); ls.className = 'mcc-pn-label'; ls.textContent = lab; b.appendChild(ls); }
        b.addEventListener('mousedown', function (e) { e.preventDefault(); });
        b.addEventListener('click', function (e) { e.preventDefault(); go(i); closePop(); });
        $list.appendChild(b);
      });
    }
    $pop.appendChild($list);
    document.body.appendChild($pop);
    setActive(curIdx);

    // Anchor under the toolbar button, clamped to the viewport.
    var r = anchor.getBoundingClientRect();
    var pw = $pop.offsetWidth || 240, ph = $pop.offsetHeight || 200;
    var left = Math.max(8, Math.min(window.innerWidth - pw - 8, Math.round(r.right - pw)));
    var top = r.bottom + 6;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
    $pop.style.left = left + 'px';
    $pop.style.top = top + 'px';

    setTimeout(function () {
      document.addEventListener('pointerdown', onOutside, true);
      window.addEventListener('resize', closePop);
      onKey = function (e) { if (e.key === 'Escape') { e.stopPropagation(); closePop(); } };
      document.addEventListener('keydown', onKey, true);
    }, 0);
    diag('mcc-pn-open', { prompts: markerRows.length });
  }

  // ---- toolbar button (headerWidget) ------------------------------------
  injectStyle();
  tv.contributes.headerWidget({
    id: 'mobile-cc-prompt-nav',
    name: 'Prompt Outline',
    preferredSlot: 'header-right',
    render: function (slot) {
      var btn = document.createElement('button');
      btn.id = 'mcc-pn-btn'; btn.type = 'button';
      btn.title = 'Prompt outline';
      btn.setAttribute('aria-label', 'Prompt outline — jump between your prompts');
      // Outline / list glyph (themable SVG, currentColor).
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
        '<circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>' +
        '<line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/></svg>';
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        if ($pop) closePop(); else openPop(btn);
      });
      slot.appendChild(btn);
      return function unmount() { closePop(); btn.remove(); };
    },
  });
  diag('mcc-pn-init', {});
})();
