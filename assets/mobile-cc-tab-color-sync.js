// mobile-cc-tab-color-sync — live-apply agent-set tab marks (the pink/green
// long-press status line) WITHOUT a reload.
//
// Background: the per-tab pink/green line is ttyview-tabs' "marks" feature
// ({ session: 'todo'|'done' }, stored at server-state key
// 'ttv-plugin:ttyview-tabs:marks'). An agent flags a tab by writing that key
// over HTTP (PUT /api/state — see the `mcc-tab-color` helper). But ttyview-core
// only HYDRATES server state at boot (no interval, no WS push) and ttyview-tabs
// caches marks in memory at init — so a server-side write would otherwise only
// show after a page reload.
//
// This plugin closes that gap: it polls the marks key and, when the SERVER
// value changes, applies the delta through window.ttvTabsSetMark (added in
// ttyview-tabs), which sets the mark + re-renders live. First poll only SEEDS
// (boot hydrate already rendered those), so we act on subsequent agent changes.
(function () {
  var tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) return;

  var POLL_INTERVAL_MS = 4000;                       // marks-sync poll cadence
  var STATE_KEY = 'ttv-plugin:ttyview-tabs:marks';
  var prevServer = null;                             // last reconciled server marks (null = not seeded)

  function normMark(v) { return (v === 'todo' || v === 'done') ? v : null; }

  // Apply only the sessions whose server mark differs from the last server
  // snapshot — so we react to SERVER changes (agent writes) and stay idempotent
  // for everything else. ttvTabsSetMark persists + re-renders.
  function applyDeltas(server) {
    if (typeof window.ttvTabsSetMark !== 'function') return;  // older bundle: no live setter
    var seen = {}, k;
    for (k in (prevServer || {})) seen[k] = 1;
    for (k in (server || {})) seen[k] = 1;
    for (k in seen) {
      var nv = normMark(server ? server[k] : null);
      var ov = normMark(prevServer ? prevServer[k] : null);
      if (nv !== ov) {
        try { window.ttvTabsSetMark(k, nv); } catch (e) {}
      }
    }
  }

  function poll() {
    if (document.visibilityState === 'hidden') return;
    fetch('/api/state', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (state) {
        if (!state) return;
        var server = (state.keys && state.keys[STATE_KEY]) || {};
        if (!server || typeof server !== 'object') server = {};
        if (prevServer === null) { prevServer = server; return; }  // seed; boot already showed these
        if (JSON.stringify(server) === JSON.stringify(prevServer)) return;
        applyDeltas(server);
        prevServer = server;
      })
      .catch(function () {});
  }

  setInterval(poll, POLL_INTERVAL_MS);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') poll();
  });
  // Seed shortly after load, once ttyview-tabs has registered ttvTabsSetMark.
  setTimeout(poll, 1500);
})();
