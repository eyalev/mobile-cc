// mobile-cc-autofit — fit the terminal to the viewport on load + pane switch.
//
// ttyview-core's autoFit() already does the right thing for a narrow phone:
// it picks the largest readable font and, when even the floor font can't fit
// the pane's columns, narrows the tmux window (resize) so the app reflows.
// BUT the core only invokes autoFit() on a viewport-resize event or a #font-fit
// click — NOT after the initial pane load or a pane switch. So on first open
// the pane stays at its created width (e.g. an 80-col Claude Code TUI) and the
// right edge clips off-screen until the user manually fits or rotates.
//
// This plugin closes that gap by triggering the existing #font-fit control once
// the grid is ready (and on every pane switch, since each pane is its own tmux
// window with its own width). It respects the user's autofit-off preference:
// if they turned auto-fit off (ttv-autofit === 'false'), we never re-enable it.
(function () {
  var tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) return;
  if (window.__mccAutofit) return;            // idempotent across re-evals
  window.__mccAutofit = true;

  function enabled() {
    try { return localStorage.getItem('ttv-autofit') !== 'false'; } catch (_) { return true; }
  }
  function fit() {
    if (!enabled()) return;
    var b = document.getElementById('font-fit');
    if (b) { try { b.click(); } catch (_) {} }
  }

  var t = null;
  function schedule() { clearTimeout(t); t = setTimeout(fit, 250); }

  // Fit when a pane's grid first renders and whenever the active pane changes.
  try { tv.on('grid-loaded', schedule); } catch (_) {}
  try { tv.on('pane-changed', schedule); } catch (_) {}

  // Safety net: the initial grid-loaded may fire before this plugin subscribes,
  // so fire once more shortly after boot.
  setTimeout(fit, 1500);
})();
