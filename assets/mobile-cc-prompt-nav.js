// mobile-cc-prompt-nav — jump between YOUR OWN prompts in the terminal.
//
// Two compact ▲/▼ buttons in the TOP TOOLBAR (headerWidget, near #scroll-bottom
// ↓). Tap ▼ → smooth-scroll #grid-host to the next submitted prompt; ▲ → the
// previous one; with a brief highlight on the target. NO overlay, NO popover —
// the controls live in the toolbar so the terminal view is never covered.
// (Earlier tries — a floating control that overlapped the right rail, then a
// popover list — were both rejected for blocking the view.)
//
// Reuses the shared scanner (window.mccMarkers) for '❯' user-prompt rows +
// chrome exclusion. Per-prompt timestamps / tint / separators live in the
// separate mobile-cc-turns "Message Regions" plugin — this is nav only.
(function () {
  var tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) {
    console.warn('[mobile-cc-prompt-nav] requires apiVersion 1');
    return;
  }

  var FLASH_MS = 1100;
  var STEP_MS = 700;

  function diag(cat, data) {
    try { if (typeof window.ttvDiag === 'function') window.ttvDiag(cat, data); } catch (e) {}
  }

  // markerRows: ordered top→bottom [{ el }]; refreshed on each interaction.
  var markerRows = [];
  var navIdx = -1, navAt = 0;     // last programmatic target (for rapid-tap stepping)

  function injectStyle() {
    if (document.getElementById('mcc-pn-styles')) return;
    var s = document.createElement('style');
    s.id = 'mcc-pn-styles';
    s.textContent =
      '.ttv-row.mcc-pn-flash{background:color-mix(in srgb,var(--ttv-rail-accent,var(--ttv-accent,#569cd6)) 28%,transparent)!important;' +
        'transition:background-color 160ms;}' +
      // compact toolbar group: ▲ ▼ side by side, sized like the other header
      // buttons so the row never overflows a narrow phone.
      '#mcc-pn-tb{display:inline-flex;align-items:center;gap:1px;}' +
      '#mcc-pn-tb button{appearance:none;background:none;border:0;color:inherit;font:inherit;' +
        'width:26px;padding:4px 0;line-height:1;cursor:pointer;border-radius:5px;}' +
      '#mcc-pn-tb button:active{background:var(--ttv-bg-elev,#333);}' +
      '#mcc-pn-tb button[disabled]{opacity:.35;cursor:default;}';
    document.head.appendChild(s);
  }

  // ---- scan + scroll ----------------------------------------------------
  function hostEl() { return document.getElementById('grid-host'); }
  function rescan() {
    var host = hostEl();
    markerRows = (host && window.mccMarkers)
      ? window.mccMarkers.userMarkers(host).map(function (m) { return { el: m.el }; })
      : [];
    syncDisabled();
    return markerRows.length;
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
    diag('mcc-pn-nav', { to: i, of: markerRows.length });
  }
  function freshBase() { return (navIdx >= 0 && (Date.now() - navAt) < STEP_MS) ? navIdx : -1; }

  function navDown() {
    if (!rescan()) return;
    var base = freshBase();
    if (base >= 0) { go(Math.min(markerRows.length - 1, base + 1)); return; }
    var host = hostEl(); var top = (host ? host.scrollTop : 0) + 6, target = -1;
    for (var i = 0; i < markerRows.length; i++) {
      if (markerRows[i].el.offsetTop > top) { target = i; break; }
    }
    go(target < 0 ? markerRows.length - 1 : target);
  }
  function navUp() {
    if (!rescan()) return;
    var base = freshBase();
    if (base >= 0) { go(Math.max(0, base - 1)); return; }
    var host = hostEl(); var top = (host ? host.scrollTop : 0) - 6, target = -1;
    for (var i = 0; i < markerRows.length; i++) {
      if (markerRows[i].el.offsetTop < top) target = i; else break;
    }
    go(target < 0 ? 0 : target);
  }

  // ---- toolbar control (headerWidget) -----------------------------------
  var $up = null, $down = null;
  function syncDisabled() {
    var none = markerRows.length === 0;
    if ($up) $up.disabled = none;
    if ($down) $down.disabled = none;
  }

  injectStyle();
  tv.contributes.headerWidget({
    id: 'mobile-cc-prompt-nav',
    name: 'Prompt Nav',
    preferredSlot: 'header-right',
    render: function (slot) {
      var box = document.createElement('span');
      box.id = 'mcc-pn-tb';
      $up = document.createElement('button');
      $up.type = 'button'; $up.textContent = '▲'; $up.tabIndex = -1;
      $up.title = 'Previous prompt'; $up.setAttribute('aria-label', 'Previous prompt');
      $down = document.createElement('button');
      $down.type = 'button'; $down.textContent = '▼'; $down.tabIndex = -1;
      $down.title = 'Next prompt'; $down.setAttribute('aria-label', 'Next prompt');
      [$up, $down].forEach(function (b) { b.addEventListener('mousedown', function (e) { e.preventDefault(); }); });
      $up.addEventListener('click', function (e) { e.preventDefault(); navUp(); });
      $down.addEventListener('click', function (e) { e.preventDefault(); navDown(); });
      box.appendChild($up); box.appendChild($down);
      slot.appendChild(box);
      rescan();
      return function unmount() { box.remove(); $up = $down = null; };
    },
  });

  // Keep the enabled/disabled state fresh as panes switch / the grid loads.
  try { tv.on('grid-loaded', function () { setTimeout(rescan, 30); }); } catch (e) {}
  try { tv.on('pane-changed', function () { navIdx = -1; setTimeout(rescan, 60); }); } catch (e) {}
  diag('mcc-pn-init', {});
})();
