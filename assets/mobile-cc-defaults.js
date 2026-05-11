// mobile-cc-defaults — seeds the first-visit active terminal view + theme.
//
// ttyview persists active_view + active_theme client-side in localStorage,
// so a fresh phone visit shows the built-in cell-grid renderer + the default
// palette instead of mobile-cc's intended chat view + Terminal Green. The
// built-in cell-grid view auto-activates the moment it registers and writes
// localStorage, so we cannot use "is localStorage empty?" as the gate — by
// the time we run, it's already set. Instead, gate on a separate sentinel
// key that mobile-cc owns: on first run (sentinel unset) we force the
// mobile-cc defaults regardless of current state, then mark the sentinel.
// On subsequent visits we are a no-op — whatever the user picked sticks.
(function () {
  if (!window.ttyview || !window.ttyview._internal) return;
  var tv = window.ttyview;
  var inner = tv._internal;

  var SENTINEL = 'mobile-cc-defaults-applied';
  try {
    if (localStorage.getItem(SENTINEL) === '1') return;
  } catch (_) { /* private mode etc. — try anyway */ }

  var WANT_VIEW = 'ttyview-cc';
  var WANT_THEME = 'ttyview-terminal-green';
  var viewDone = false;
  var themeDone = false;

  function maybeMarkDone() {
    if (viewDone && themeDone) {
      try { localStorage.setItem(SENTINEL, '1'); } catch (_) {}
    }
  }

  function force(kind, id, setter) {
    if (!inner.registries[kind] || !inner.registries[kind].has(id)) return false;
    try { inner[setter](id); } catch (e) {
      console.warn('mobile-cc-defaults: ' + setter + ' threw', e);
    }
    return true;
  }

  viewDone = force('terminalView', WANT_VIEW, 'setActiveTerminalViewId');
  themeDone = force('theme', WANT_THEME, 'setActiveThemeId');

  if (!viewDone) {
    tv.on('terminalView-registered', function (def) {
      if (def && def.id === WANT_VIEW && !viewDone) {
        viewDone = force('terminalView', WANT_VIEW, 'setActiveTerminalViewId');
        maybeMarkDone();
      }
    });
  }
  if (!themeDone) {
    tv.on('theme-registered', function (def) {
      if (def && def.id === WANT_THEME && !themeDone) {
        themeDone = force('theme', WANT_THEME, 'setActiveThemeId');
        maybeMarkDone();
      }
    });
  }

  maybeMarkDone();
})();
