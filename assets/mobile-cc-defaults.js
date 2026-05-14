// mobile-cc-defaults — historically forced ttyview-cc chat view +
// Terminal Green theme on first visit. As of v0.1.4 both have been
// dropped: the actual terminal (cell-grid, neutral VS Code Dark+
// palette) is what users see by default, matching the tooling
// they're already familiar with.
//
// The plugin is preserved (rather than deleted) so the sentinel
// still gets stamped; future mobile-cc releases that want their own
// run-once first-visit logic can hook in here.
(function () {
  if (!window.ttyview || !window.ttyview._internal) return;

  var SENTINEL = 'mobile-cc-defaults-applied';
  try {
    if (localStorage.getItem(SENTINEL) === '1') return;
  } catch (_) { /* private mode etc. — try anyway */ }

  // No defaults forced anymore. Earlier versions of this file
  // activated `ttyview-cc` (chat-bubble view of the JSONL
  // transcript) + `ttyview-terminal-green` theme on first visit.
  // Users prefer the actual terminal — `cell-grid` is ttyview's
  // OOTB auto-default and renders the real claude TUI, including
  // its loading state, dialogs, and any non-CC TUI (vim, top,
  // etc.) the user attaches to. Both `ttyview-cc` and the Terminal
  // Green theme stay *installed* — switchable from Settings →
  // Plugins — they just aren't activated for you.
  //
  // The whole plugin is kept (rather than removed) so the sentinel
  // still gets marked; that way if a future mobile-cc release
  // re-introduces opinionated defaults, this file's run-once
  // semantics still hold for users who installed an earlier
  // version.
  try { localStorage.setItem(SENTINEL, '1'); } catch (_) {}
})();
