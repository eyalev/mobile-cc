// mobile-cc-tab-color-sync — live-apply agent-set tab marks (the pink/green
// long-press status line) WITHOUT a reload, and WITHOUT its own poll.
//
// Background: the per-tab pink/green line is ttyview-tabs' "marks" feature
// ({ session: 'todo'|'done' }, stored at server-state key
// 'ttv-plugin:ttyview-tabs:marks'). An agent flags a tab by writing that key
// over HTTP (the `mcc-tab-color` helper PATCHes /api/state). ttyview-core only
// HYDRATES server state at boot, and ttyview-tabs caches marks in memory at
// init — so a server-side write would otherwise only show after a reload.
//
// HOW THIS CLOSES THE GAP (battery-trio item 1, 2026-06-23):
// The bundled ttyview-live-sync plugin already polls /api/state every 1.5 s and,
// for every changed `ttv-plugin:<id>:<key>`, writes the localStorage cache and
// emits 'storage-changed' {pluginId, key, value, source}. ttyview-tabs does NOT
// subscribe to that event for marks, so its in-memory `marks` stays stale. This
// plugin bridges: it listens for live-sync's 'storage-changed' for the marks key
// and applies the delta through window.ttvTabsSetMark (sets the mark + re-renders
// live). Same apply path as before — we only changed the TRIGGER from our own 4 s
// GET /api/state poll to live-sync's existing poll. Net: one fewer periodic HTTP
// request per client (see the perf audit), zero behavior change.
(function () {
  var tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) return;

  var PLUGIN_ID = 'ttyview-tabs';
  var STATE_SUBKEY = 'marks';                        // ttv-plugin:ttyview-tabs:marks
  var LS_KEY = 'ttv-plugin:' + PLUGIN_ID + ':' + STATE_SUBKEY;

  function normMark(v) { return (v === 'todo' || v === 'done') ? v : null; }

  // Seed from the boot-hydrated localStorage cache (hydrateServerState runs
  // before plugins load), so the first agent change reads as a real delta
  // rather than a replay of what boot already rendered. live-sync likewise
  // treats its first fetch as a baseline and only emits on later changes.
  var prevServer = (function () {
    try { var r = localStorage.getItem(LS_KEY); return r ? (JSON.parse(r) || {}) : {}; }
    catch (e) { return {}; }
  })();

  // Apply only the sessions whose mark differs from the last reconciled
  // snapshot — react to SERVER changes (agent writes), idempotent otherwise.
  // ttvTabsSetMark persists + re-renders (incl. duplicate tabs of a session).
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

  function reconcile(value) {
    var server = (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
    if (JSON.stringify(server) === JSON.stringify(prevServer)) return;
    applyDeltas(server);
    prevServer = server;
  }

  // Driven entirely by live-sync's poll — no fetch / setInterval here.
  tv.on('storage-changed', function (e) {
    if (!e || e.pluginId !== PLUGIN_ID || e.key !== STATE_SUBKEY) return;
    reconcile(e.value);
  });
})();
