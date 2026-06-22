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

  // Default the initial pane to the Claude Code session. ttyview-core's
  // pickInitialPane() — which runs right AFTER plugins load — restores the
  // last-viewed pane via ttv-last-pane-id (exact id) then ttv-last-session
  // (name, survives tmux/VM restarts), falling back to the first pane.
  // mobile-cc's whole job is "drive Claude Code", so when nothing is stored
  // yet (fresh browser / new VM) we seed ttv-last-session='claude' so the app
  // opens on the claude session. Absence-guarded on BOTH keys, so a real
  // last-viewed pane is never clobbered.
  try {
    if (!localStorage.getItem('ttv-last-pane-id') && !localStorage.getItem('ttv-last-session')) {
      localStorage.setItem('ttv-last-session', 'claude');
    }
  } catch (_) { /* private mode etc. — pickInitialPane falls back to first pane */ }

  // Seed the tabs plugin's settings for the mobile-cc shape: a 3-row
  // tab grid (3 tabs per row, pinned mode) at the bottom of the
  // screen. Deliberately OUTSIDE the run-once sentinel and guarded on
  // key absence instead: it must reach existing installs that predate
  // the tab grid, while never clobbering a user's own customization
  // (any Settings edit writes the key, which blocks re-seeding).
  // Plugin storage is server-synced, so one browser seeding covers
  // every device.
  //
  // maxPerRow MUST match mobile-cc-tabs.js's seededPerRow value (3): that
  // plugin loads after this one and overrides maxPerRow to 3, so keeping
  // them in agreement removes the contradiction and makes the result
  // independent of plugin load order.
  try {
    var tabsStore = window.ttyview.storage('ttyview-tabs');
    if (tabsStore && tabsStore.get('settings') == null) {
      // recentRow:false — the upstream default shows an always-on "recent
      // sessions" strip above the project groups. On a fresh mobile-cc it
      // reads as a confusing lone tab above the grid, so mobile-cc ships it
      // off. Re-enable any time via Settings → Pinned Tabs → "Show recent
      // tabs row" (the 🕘 rail mode still gives on-demand recents).
      tabsStore.set('settings', { rows: 3, maxPerRow: 3, mode: 'pinned', recentRow: false });
    }

    // Pin the "mcc" group to its own color. The tabs plugin derives a
    // group's bracket color from a deterministic name→palette hash, and
    // "mcc" happens to hash to the same pink (#f7768e) as the "todo"
    // group — visually confusing on a rail that carries both. mobile-cc
    // owns the "mcc" convention, so seed an explicit override: teal,
    // distinct from pink (todo), purple (opendev), and the blue
    // active-tab highlight. Per-group state lives under the `groups`
    // key as { [name]: { collapsed?, color?, order? } }. Absence-guarded
    // on the color field only, so a user's own color edit is never
    // clobbered and an existing group's order/collapsed state is kept.
    if (tabsStore) {
      var groups = tabsStore.get('groups') || {};
      if (!groups.mcc || !groups.mcc.color) {
        groups.mcc = Object.assign({}, groups.mcc, { color: '#73daca' });
        tabsStore.set('groups', groups);
      }
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
