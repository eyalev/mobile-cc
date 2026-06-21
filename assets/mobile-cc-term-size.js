// mobile-cc-term-size — shrink the terminal's visible height from a
// top-bar disclosure popover. PURELY VISUAL: it adds bottom padding to
// #grid-host, it does NOT resize the tmux pane.
//
// Why not resize tmux: the pane's window-size is shared/`latest` and
// core fit-resize re-asserts it continuously, so any real resize gets
// reverted ("moves then jumps back"). Padding sidesteps that war
// entirely — the tmux pane is never touched, so nothing can revert it.
//
// Tradeoff (accepted): the pane keeps its real size, so the shorter
// area shows a SLICE of it — the tail (latest output + prompt), which
// is what you want while driving from a phone — and we keep the view
// pinned to the bottom so the newest line sits just above the padding.
// Older lines / the top of a full-screen TUI scroll off; scroll up for
// them.
//
// Mechanics: a CSS var --mcc-term-pad drives #grid-host's padding-bottom
// (added to the stock 4px). Because padding lives INSIDE the box, the
// host's clientHeight/offsetHeight don't change, so no ResizeObserver /
// autoFit path fires. The inset persists (mobile-cc-term-size.pad) and
// re-applies on load. Reset → 0 (full height).
//
// UI: one disclosure button (⇕) in the header → popover grouping the
// relocated font A−/↔/A+ proxies + Height −/[px]/+ and reset.
(function () {
  var tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) return;
  if (window.__mccTermSize) return;            // idempotent across re-evals
  window.__mccTermSize = true;

  var STORAGE = tv.storage('mobile-cc-term-size');
  var PAD_KEY = 'pad';                         // px of extra bottom inset
  var STEP = 48, MIN = 0, MAX = 640;
  var BASE_PAD = 4;                            // stock #grid-host padding-bottom

  function inset() {
    var v = STORAGE.get(PAD_KEY);
    return (typeof v === 'number' && v >= 0) ? Math.min(MAX, v) : 0;
  }
  function setInset(px) { STORAGE.set(PAD_KEY, Math.max(MIN, Math.min(MAX, Math.round(px)))); }

  // ---- apply the inset --------------------------------------------
  var STYLE_ID = 'mobile-cc-term-size-style';
  function ensureStyle() {
    var s = document.getElementById(STYLE_ID);
    if (!s) {
      s = document.createElement('style');
      s.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(s);
      // padding-bottom only; calc() folds in the stock 4px so we don't
      // clobber the host's top/side padding.
      s.textContent =
        '#grid-host { padding-bottom: calc(' + BASE_PAD + 'px + var(--mcc-term-pad, 0px)) !important; }';
    }
  }
  function scrollTail() {
    var gh = document.getElementById('grid-host');
    if (gh) { try { gh.scrollTop = gh.scrollHeight; } catch (_) {} }
  }
  function apply() {
    ensureStyle();
    document.documentElement.style.setProperty('--mcc-term-pad', inset() + 'px');
    // Keep the newest line pinned just above the padding after a reflow.
    scrollTail();
    setTimeout(scrollTail, 60);
  }
  apply();                                      // restore persisted inset on load

  // ---- popover ---------------------------------------------------
  var pop = null, outsideHandler = null;

  function visibleH() {
    var gh = document.getElementById('grid-host');
    if (!gh) return 0;
    return Math.max(0, Math.round(gh.clientHeight - inset()));
  }
  function renderReadout() {
    if (!pop) return;
    var r = pop.querySelector('#mcc-ts-n');
    if (r) r.textContent = visibleH() || '–';
  }

  // − = shorter terminal (more inset); + = taller (less inset).
  function nudge(deltaInset) {
    setInset(inset() + deltaInset);
    apply();
    renderReadout();
  }
  function reset() { setInset(0); apply(); renderReadout(); }
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

    // Font row — proxy-clicks the existing header buttons so font
    // controls can live here, off the crowded top bar.
    var fontRow = mkRow('Font');
    fontRow.appendChild(mkBtn('A−', 'Smaller font', function () { fontClick('font-down'); }));
    fontRow.appendChild(mkBtn('↔', 'Auto-fit', function () { fontClick('font-fit'); }));
    fontRow.appendChild(mkBtn('A+', 'Larger font', function () { fontClick('font-up'); }));
    el.appendChild(fontRow);

    // Height row — the visual inset control.
    var hRow = mkRow('Height');
    hRow.appendChild(mkBtn('−', 'Shorter terminal', function () { nudge(+STEP); }));
    var n = document.createElement('span');
    n.id = 'mcc-ts-n';
    n.style.cssText = 'min-width:38px;text-align:center;color:var(--ttv-fg);font-size:13px;font-variant-numeric:tabular-nums;';
    hRow.appendChild(n);
    hRow.appendChild(mkBtn('+', 'Taller terminal', function () { nudge(-STEP); }));
    hRow.appendChild(mkBtn('⟲', 'Reset to full height', function () { reset(); }));
    el.appendChild(hRow);

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
