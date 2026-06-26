// mobile-cc-kbd-passthrough — type straight into the terminal with a physical
// keyboard (desktop/laptop only).
//
// mobile-cc's input model is mobile-first: everything goes through the bottom
// Message box (compose + Enter → sendInput(text+'\r')). On a laptop that's
// awkward when Claude shows a prompt like "1. Submit / 2. Cancel" or an
// arrow-key picker — you want to just press 1/2 or ↑↓+Enter.
//
// This plugin makes #grid-host focusable: CLICK the terminal and your physical
// keystrokes are translated to terminal byte sequences and sent to the active
// pane (preventDefault so they don't land in the Message box). Click the
// Message box (or anywhere outside the terminal) and you're back to composing.
// A focus ring + a small "keyboard → terminal" hint show which mode you're in.
//
// Touch devices are excluded (they keep the Message box + quick-keys row).
// Copy/paste stays with the browser: Ctrl/Cmd-C with a selection copies; a
// bare Ctrl-C (no selection) sends SIGINT. Cmd-* and Ctrl-K (palette) pass
// through to the browser/app.
(function () {
  var tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) return;
  if (window.__mccKbdPassthrough) return;
  window.__mccKbdPassthrough = true;

  // Desktop/laptop only — phones/tablets keep the Message box + quick-keys.
  // Gate on a FINE pointer (mouse/trackpad), not "has touch": a touchscreen
  // laptop has both and should still get passthrough; a phone has only coarse.
  var fine = window.matchMedia && window.matchMedia('(any-pointer: fine)').matches;
  if (!fine) return;

  function injectStyle() {
    if (document.getElementById('mcc-kbd-style')) return;
    var s = document.createElement('style');
    s.id = 'mcc-kbd-style';
    s.textContent = [
      '#grid-host.mcc-kbd-focus { outline: 2px solid var(--ttv-accent, #4aa3ff); outline-offset: -2px; }',
      '#mcc-kbd-hint {',
      '  position: fixed; z-index: 50; right: 10px; bottom: 64px;',
      '  background: var(--ttv-accent, #4aa3ff); color: #001018;',
      '  font: 600 11px/1 ui-monospace, Menlo, Consolas, monospace;',
      '  padding: 5px 8px; border-radius: 6px; pointer-events: none;',
      '  opacity: 0; transition: opacity .12s ease; box-shadow: 0 2px 8px rgba(0,0,0,.35);',
      '}',
      '#mcc-kbd-hint.on { opacity: .92; }',
    ].join('\n');
    document.head.appendChild(s);
  }

  var hint = null;
  function ensureHint() {
    if (hint) return hint;
    hint = document.createElement('div');
    hint.id = 'mcc-kbd-hint';
    hint.textContent = '⌨ keyboard → terminal';
    document.body.appendChild(hint);
    return hint;
  }

  // Translate a keydown into the bytes a terminal expects. Return null to let
  // the browser/app handle the event (copy/paste, palette, unknown keys).
  function seqFor(e) {
    var k = e.key;
    if (e.metaKey) return null;                 // Cmd-* → browser (copy, etc.)
    if (e.ctrlKey) {
      var low = (k.length === 1) ? k.toLowerCase() : k;
      if (low === 'c' || low === 'v' || low === 'x' || low === 'a') {
        var sel = (window.getSelection && String(window.getSelection())) || '';
        if (low === 'c' && !sel) return '\x03'; // bare Ctrl-C (no selection) → SIGINT
        return null;                            // copy/paste/cut/select-all → browser
      }
      if (low === 'k') return null;             // command palette (Ctrl-K)
      if (low >= 'a' && low <= 'z') return String.fromCharCode(low.charCodeAt(0) - 96);
      return null;
    }
    switch (k) {
      case 'Enter':      return '\r';
      case 'Backspace':  return '\x7f';
      case 'Tab':        return e.shiftKey ? '\x1b[Z' : '\t';
      case 'Escape':     return '\x1b';
      case 'ArrowUp':    return '\x1b[A';
      case 'ArrowDown':  return '\x1b[B';
      case 'ArrowRight': return '\x1b[C';
      case 'ArrowLeft':  return '\x1b[D';
      case 'Home':       return '\x1b[H';
      case 'End':        return '\x1b[F';
      case 'PageUp':     return '\x1b[5~';
      case 'PageDown':   return '\x1b[6~';
      case 'Delete':     return '\x1b[3~';
      case 'Insert':     return '\x1b[2~';
    }
    if (e.altKey && k.length === 1) return '\x1b' + k;  // Alt/Meta prefix
    if (k.length === 1) return k;               // printable
    return null;                                // F-keys etc. — ignore
  }

  function wire(host) {
    if (host.__mccKbd) return;
    host.__mccKbd = true;
    injectStyle();
    if (!host.hasAttribute('tabindex')) host.tabIndex = 0;

    // Click the terminal to focus it (no preventDefault → text selection for
    // copy still works).
    host.addEventListener('mousedown', function () {
      try { host.focus({ preventScroll: true }); } catch (_) { host.focus(); }
    });

    host.addEventListener('focus', function () {
      host.classList.add('mcc-kbd-focus');
      ensureHint().classList.add('on');
    });
    host.addEventListener('blur', function () {
      host.classList.remove('mcc-kbd-focus');
      if (hint) hint.classList.remove('on');
    });

    host.addEventListener('keydown', function (e) {
      if (document.activeElement !== host) return;
      var seq = seqFor(e);
      if (seq == null) return;                  // let the browser handle it
      var pane = tv.getActivePane && tv.getActivePane();
      if (!pane) return;
      try { tv.sendInput(pane.id, seq); } catch (_) { return; }
      e.preventDefault();
      e.stopPropagation();
    }, true);
  }

  function init() {
    var host = document.getElementById('grid-host');
    if (host) { wire(host); return; }
    setTimeout(init, 500);                       // grid not mounted yet
  }
  init();
})();
