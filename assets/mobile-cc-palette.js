// mobile-cc-palette — the "type anything → it happens" front door.
//
// ttyview-core already ships a command palette (Ctrl/Cmd-K overlay, fuzzy
// search, window.ttyview.openCommandPalette()). On a phone there's no
// keyboard shortcut and the overlay is desktop-shaped, and almost nothing
// registers commands. This internal plugin closes both gaps WITHOUT any
// core change:
//   1. a header-right 🔍 button that opens the palette (mobile entry point);
//   2. a mobile restyle of the overlay (full-height sheet, sticky 16px input,
//      big tap targets) injected as <style>;
//   3. a populated command set built on the EXISTING zero-arg
//      tv.contributes.command({id,name,handler}) API — including the
//      high-value DYNAMIC commands "Go to: <session>" (fast switcher) and
//      "Run: <chip>" (the command-chip list), regenerated on pane/registry
//      changes the same way core regenerates its per-theme switchers.
//
// This is slice 1 of .claude/command-palette-spec.md — deterministic, no AI,
// no args. The args/AI/delegate slices layer on top later.
(function () {
  var tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) {
    if (tv && tv.apiVersion !== 1) console.warn('[mobile-cc-palette] requires apiVersion 1');
    return;
  }

  // ---- 1. mobile restyle of the core overlay --------------------------
  // Scoped to narrow screens so desktop keeps the centered card. We anchor
  // the sheet to the TOP with a sticky input rather than the bottom, so the
  // soft keyboard can't cover the search field (the kbd-overlay plugin makes
  // the keyboard overlay content; a bottom sheet would sit under it).
  (function injectStyle() {
    if (document.getElementById('mcc-palette-style')) return;
    var st = document.createElement('style');
    st.id = 'mcc-palette-style';
    st.textContent =
      '@media (max-width: 640px) {' +
      '  #cmd-palette-overlay { padding-top: 0; align-items: stretch; }' +
      '  #cmd-palette { width: 100vw; max-width: 100vw; max-height: 100dvh;' +
      '    height: 100dvh; border-radius: 0; border-left: none; border-right: none; }' +
      '  #cmd-palette input { font-size: 16px; padding: 16px 16px; position: sticky; top: 0;' +
      '    background: var(--ttv-bg-elev2); z-index: 1; }' +
      '  .cmdp-item { padding: 14px 16px; font-size: 15px; }' +
      '  .cmdp-item .cmdp-id { font-size: 12px; }' +
      '}';
    document.head.appendChild(st);
  })();

  // ---- 2. header-right button (themable SVG, not an emoji) -------------
  function searchSvg() {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '20'); svg.setAttribute('height', '20');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    var c = document.createElementNS(ns, 'circle');
    c.setAttribute('cx', '11'); c.setAttribute('cy', '11'); c.setAttribute('r', '7');
    var l = document.createElementNS(ns, 'line');
    l.setAttribute('x1', '21'); l.setAttribute('y1', '21');
    l.setAttribute('x2', '16.65'); l.setAttribute('y2', '16.65');
    svg.appendChild(c); svg.appendChild(l);
    return svg;
  }

  function openPalette() {
    if (typeof tv.openCommandPalette === 'function') tv.openCommandPalette();
    else if (typeof window.ttyview.openCommandPalette === 'function') window.ttyview.openCommandPalette();
    else tv.toast && tv.toast('Command palette unavailable');
  }

  tv.contributes.headerWidget({
    id: 'mobile-cc-palette',
    name: 'Command palette',
    preferredSlot: 'header-right',
    render: function (slot) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.tabIndex = -1;                              // don't steal focus on touch
      btn.title = 'Search & act (commands)';
      btn.setAttribute('aria-label', 'Open command palette');
      btn.style.cssText = 'cursor:pointer;display:inline-flex;align-items:center;';
      btn.appendChild(searchSvg());
      // Touch handling mirrors quickkeys/commands: act on pointerup, keep the
      // soft keyboard from blurring the active pane via mousedown.preventDefault.
      btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
      btn.addEventListener('pointerup', function (e) { e.preventDefault(); openPalette(); });
      btn.addEventListener('click', function (e) { e.preventDefault(); });
      slot.appendChild(btn);
      return function unmount() { btn.remove(); };
    },
  });

  // ---- 3a. static commands (existing mobile-cc capabilities) ----------
  function clickById(id) { var el = document.getElementById(id); if (el) el.click(); }

  function applyScrollback(rows) {
    try { localStorage.setItem('ttv-scrollback-rows', String(rows)); } catch (e) {}
    if (typeof window.loadGrid === 'function') window.loadGrid();   // re-fetch active pane so it applies live
    tv.toast && tv.toast('Scrollback: ' + rows + ' lines');
  }

  [200, 1000, 2000, 5000, 10000].forEach(function (n) {
    tv.contributes.command({
      id: 'mcc.scrollback.' + n,
      name: 'Scrollback: ' + n.toLocaleString() + ' lines',
      handler: function () { applyScrollback(n); },
    });
  });

  tv.contributes.command({ id: 'mcc.font.fit',  name: 'Fit terminal to width', handler: function () { clickById('font-fit'); } });
  tv.contributes.command({ id: 'mcc.font.up',   name: 'Font: bigger',          handler: function () { clickById('font-up'); } });
  tv.contributes.command({ id: 'mcc.font.down', name: 'Font: smaller',         handler: function () { clickById('font-down'); } });

  // ---- 3b. DYNAMIC commands: Go to <session> + Run <chip> --------------
  // Regenerated on pane/registry changes, exactly like core's
  // syncThemeCommands(): drop our prefixed keys, then re-add fresh ones.
  var REG = tv._internal && tv._internal.registries && tv._internal.registries.command;
  function emit(ev, def) { tv._internal && tv._internal.emit && tv._internal.emit(ev, def); }

  function dropPrefixed(prefix) {
    if (!REG) return;
    [].slice.call(REG.keys()).forEach(function (k) {
      if (k.indexOf(prefix) === 0) { var d = REG.get(k); REG.delete(k); emit('command-unregistered', d); }
    });
  }

  function syncGotoCommands() {
    dropPrefixed('mcc.goto.');
    var panes = (tv.listPanes && tv.listPanes()) || [];
    var seen = {};
    panes.forEach(function (p) {
      if (!p || !p.session || seen[p.session]) return;
      seen[p.session] = 1;
      tv.contributes.command({
        id: 'mcc.goto.' + p.session,
        name: 'Go to: ' + p.session,
        handler: (function (paneId) { return function () { tv.selectPane && tv.selectPane(paneId); }; })(p.id),
      });
    });
  }

  function syncRunCommands() {
    dropPrefixed('mcc.run.');
    var list = [];
    try { list = tv.storage('mobile-cc-commands').get('commands') || []; } catch (e) {}
    list.forEach(function (c, i) {
      if (!c || !c.cmd) return;
      tv.contributes.command({
        id: 'mcc.run.' + i,
        name: 'Run: ' + (c.label || c.cmd),
        handler: (function (cmd) { return function () { tv.sendInput(null, cmd + '\r'); }; })(c.cmd),  // LF→CR so Enter fires
      });
    });
  }

  function syncDynamic() { syncGotoCommands(); syncRunCommands(); }
  syncDynamic();
  ['panes-updated', 'pane-changed'].forEach(function (ev) { tv.on(ev, syncDynamic); });
})();
