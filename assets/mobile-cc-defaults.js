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

  // Lock to upright portrait so rotating the phone doesn't reflow the
  // app. Runs on EVERY load (an orientation lock doesn't persist
  // across page loads) — deliberately above the run-once sentinel.
  // Best-effort: screen.orientation.lock() is only honored in an
  // installed standalone PWA on Android Chrome; a plain browser tab
  // rejects it (no fullscreen). The manifest's
  // orientation:"portrait-primary" is the durable counterpart for the
  // installed app. Silently no-ops where unsupported (desktop, iOS).
  try {
    var so = window.screen && window.screen.orientation;
    if (so && typeof so.lock === 'function') {
      var pr = so.lock('portrait-primary');
      if (pr && typeof pr.catch === 'function') pr.catch(function () {});
    }
  } catch (_) { /* unsupported / not allowed — leave orientation free */ }

  // Seed the tabs plugin's settings for the mobile-cc shape: a 3-row
  // tab grid (4 tabs per row, pinned mode) at the bottom of the
  // screen. Deliberately OUTSIDE the run-once sentinel and guarded on
  // key absence instead: it must reach existing installs that predate
  // the tab grid, while never clobbering a user's own customization
  // (any Settings edit writes the key, which blocks re-seeding).
  // Plugin storage is server-synced, so one browser seeding covers
  // every device.
  try {
    var tabsStore = window.ttyview.storage('ttyview-tabs');
    if (tabsStore && tabsStore.get('settings') == null) {
      tabsStore.set('settings', { rows: 3, maxPerRow: 4, mode: 'pinned' });
    }
  } catch (_) { /* cosmetic default — never block boot */ }

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
