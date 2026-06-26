// mobile-cc-tap-focus — click the terminal to focus the Message box, with a
// brief pulse so it's obvious where focus landed.
//
// On desktop the terminal grid fills most of the window, but the thing you
// actually type into is the composer at the bottom. Clicking "near the prompt"
// reads as "let me type here" — so a click anywhere on the terminal focuses
// #input-text and flashes a short accent ring around it as a focus cue.
//
// Scoped + guarded so it only ever helps:
//   • Desktop mouse only — gated on (hover:hover)+(pointer:fine). On a touch
//     device, focusing the textarea pops the soft keyboard, which would be a
//     nasty surprise on every stray tap; mobile users tap the box directly.
//   • Never steals a text selection — if the click ended a drag-select (a
//     non-collapsed selection), we leave focus alone so select-to-copy works.
//   • Never hijacks a link/path tap — those are owned by mobile-cc-download's
//     popover; we bail when the target is inside one.
(function () {
  var tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) return;
  if (window.__mccTapFocus) return;            // idempotent across re-evals
  window.__mccTapFocus = true;

  function isDesktopMouse() {
    try { return window.matchMedia('(hover: hover) and (pointer: fine)').matches; }
    catch (_) { return false; }
  }

  // Flash CSS — a short accent ring that expands and fades. The textarea's
  // own :focus border (accent) stays; this is the momentary "landed here" cue.
  var style = document.createElement('style');
  style.textContent =
    '@keyframes mccFocusFlash{' +
      '0%{box-shadow:0 0 0 2px var(--ttv-accent,#E8896B);}' +
      '55%{box-shadow:0 0 0 2px var(--ttv-accent,#E8896B);}' +
      '100%{box-shadow:0 0 8px 5px transparent;}' +
    '}' +
    '#input-text.mcc-focus-flash{animation:mccFocusFlash 600ms ease-out;border-radius:6px;}';
  (document.head || document.documentElement).appendChild(style);

  function flash(el) {
    el.classList.remove('mcc-focus-flash');
    void el.offsetWidth;                        // reflow → restart animation
    el.classList.add('mcc-focus-flash');
    var done = function () {
      el.classList.remove('mcc-focus-flash');
      el.removeEventListener('animationend', done);
    };
    el.addEventListener('animationend', done);
    setTimeout(done, 800);                       // fallback if animationend misses
  }

  function onClick(e) {
    if (!isDesktopMouse()) return;
    // Leave link/path taps to the download plugin's popover.
    if (e.target && e.target.closest && e.target.closest('.mcc-link, .mcc-path, .mcc-url')) return;
    // Preserve a real text selection (drag-select to copy).
    var sel = window.getSelection && window.getSelection();
    if (sel && !sel.isCollapsed && String(sel).length) return;
    var ta = document.getElementById('input-text');
    if (!ta) return;
    try { ta.focus({ preventScroll: true }); } catch (_) { try { ta.focus(); } catch (_) {} }
    flash(ta);
  }

  function bind() {
    var h = document.getElementById('grid-host');
    if (!h) { setTimeout(bind, 300); return; }
    // #grid-host is the stable mount point (its cell-grid children are
    // recreated on re-render, but the host itself persists), so one listener
    // here survives pane switches and re-renders.
    h.addEventListener('click', onClick);
  }
  bind();
})();
