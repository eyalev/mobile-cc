// mobile-cc-scroll-memory — remember the terminal scroll position per pane,
// across pane switches AND full app restarts; stop the "jumps to the bottom by
// itself" behavior.
//
// THE BUG: ttyview-core's cell-grid rebuilds the whole DOM on every grid-loaded
// (initial open, pane switch, reconnect, resize-reseed) and ends buildGrid()
// with an UNCONDITIONAL `host.scrollTop = host.scrollHeight` (ui/index.html
// ~3320, no "was the user at the bottom?" guard). grid-loaded fires often, so
// you get yanked to the tail repeatedly.
//
// THE FIX (flash-free, no core edit): buildGrid is a grid-loaded handler
// registered INSIDE index.html (~line 3612). A mobile-cc plugin's grid-loaded
// handler registers LATER, so it runs AFTER buildGrid in the SAME synchronous
// emit() — we override the tail-scroll before the browser paints.
//
// CAPTURING INTENT — the hard part. buildGrid / prefill / our own restore all
// fire indistinguishable 'scroll' events, so a debounced scroll-saver can't
// tell user intent from machine churn (the v1 bug: it only ever recorded
// follow:true). Instead we treat a USER gesture (wheel / touchmove) as the only
// signal of intent, and COMMIT the resulting position on 'scrollend' (fires
// after momentum settles). Programmatic scrolls emit no wheel/touch, so they
// never overwrite the saved state.
//
// WHAT WE REMEMBER: per pane, "follow the live tail" (you were at the bottom)
// OR a distance-from-bottom in px (you scrolled up). Anchoring to the BOTTOM is
// invariant under the deep-scrollback prefill (it prepends ABOVE), so the
// restore stays correct as older history streams in. State is in localStorage
// (`mcc-scroll-pos`) → survives an app restart. Tail-followers are unaffected.
//
// Verify:  grep '"cat":"scroll-\(save\|restore\)"' ~/.config/mobile-cc/diag.jsonl | tail
(function () {
  var tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) return;
  if (window.__mccScrollMem) return;           // idempotent across re-evals
  window.__mccScrollMem = true;

  var KEY = 'mcc-scroll-pos';
  var AT_BOTTOM = 30;          // px slack: within this of the tail == "following"
  var GESTURE_MS = 1500;       // a scrollend counts as user-intent if a gesture
                               // happened within this window before it
  var lastGesture = 0;
  // The active pane id, tracked from grid-loaded / pane-changed events.
  // tv.api.getActivePane() proved unreliable here (returns null), so commit()
  // — which has no event to read from — uses this instead.
  var curPane = null;

  function diag(cat, data) {
    try { if (typeof window.ttvDiag === 'function') window.ttvDiag(cat, data); } catch (_) {}
  }
  function readMap() {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_) { return {}; }
  }
  function writeMap(m) {
    try { localStorage.setItem(KEY, JSON.stringify(m)); } catch (_) {}
  }
  function activeId() {
    if (curPane) return curPane;
    try {
      var p = tv.api && tv.api.getActivePane && tv.api.getActivePane();
      return (p && p.id) || null;
    } catch (_) { return null; }
  }
  function host() { return document.getElementById('grid-host'); }

  // --- commit the current position as USER intent for the active pane -------
  function commit(reason) {
    var h = host(); if (!h) return;
    var id = activeId(); if (!id) return;
    var dist = h.scrollHeight - h.scrollTop - h.clientHeight;
    var follow = dist < AT_BOTTOM;
    var m = readMap();
    m[id] = { follow: follow, dist: Math.max(0, Math.round(dist)), ts: Date.now() };
    var ids = Object.keys(m);                  // cap: dead tmux %N can't grow it
    if (ids.length > 60) {
      ids.sort(function (a, b) { return (m[a].ts || 0) - (m[b].ts || 0); });
      for (var i = 0; i < ids.length - 60; i++) delete m[ids[i]];
    }
    writeMap(m);
    diag('scroll-save', { pane: id, follow: follow, dist: m[id].dist, why: reason || '' });
  }

  // --- restore: runs AFTER core's buildGrid in the same tick → flash-free ---
  function restore(paneId) {
    var h = host(); if (!h) return;
    var st = paneId ? (readMap()[paneId] || null) : null;
    var target;
    if (!st || st.follow) target = h.scrollHeight;                 // follow tail
    else { target = h.scrollHeight - h.clientHeight - st.dist; if (target < 0) target = 0; }
    h.scrollTop = target;
    diag('scroll-restore', {
      pane: paneId || null, follow: !st || !!st.follow, dist: st ? st.dist : 0,
      set: Math.round(h.scrollTop), sh: Math.round(h.scrollHeight), ch: Math.round(h.clientHeight),
    });
  }

  // --- re-assert the saved position through the post-load reflow window -----
  // restore() runs ONCE in the grid-loaded handler, but the grid keeps changing
  // AFTER it: auto-fit (font re-render → row heights change → scrollHeight
  // changes) and the deep-scrollback prefill (prepends older rows in idle rAF
  // chunks). Two failure modes this repairs:
  //   (a) FOLLOW pane drifts off the bottom (clientHeight seen 488→553→603 in
  //       one load) → re-pin to the tail.
  //   (b) SCROLLED-UP pane can't reach deep history. At grid-loaded only the
  //       fast ~200-row tail is painted, so restore() clamps a dist deeper than
  //       the tail to scrollTop 0; the prefill then anchors that wrong position
  //       invariant ("works till a certain point"). Once the prefill has grown
  //       scrollHeight to cover the saved dist, re-applying dist-from-bottom
  //       reaches the real position.
  // Both bail the moment the user takes over with a real gesture, so we never
  // fight a deliberate scroll.
  function reassert(paneId, why) {
    if (Date.now() - lastGesture < GESTURE_MS) return;   // user has the wheel → hands off
    var h = host(); if (!h) return;
    var st = readMap()[paneId];
    var target;
    if (!st || st.follow) target = h.scrollHeight;                      // follow tail
    else { target = h.scrollHeight - h.clientHeight - st.dist; if (target < 0) target = 0; }
    h.scrollTop = target;
    diag('scroll-reassert', {
      pane: paneId || null, follow: !st || !!st.follow, dist: st ? st.dist : 0, why: why || '',
      set: Math.round(h.scrollTop), sh: Math.round(h.scrollHeight), ch: Math.round(h.clientHeight),
    });
  }
  function scheduleReassert(paneId) {
    // Spread across the settle: rAF (layout), then catch auto-fit + the first
    // few prefill chunks. Each call is individually gesture-guarded.
    requestAnimationFrame(function () { reassert(paneId, 'sched-raf'); });
    setTimeout(function () { reassert(paneId, 'sched-120'); }, 120);
    setTimeout(function () { reassert(paneId, 'sched-400'); }, 400);
    setTimeout(function () { reassert(paneId, 'sched-800'); }, 800);
  }
  // The deep prefill prepends in idle rAF chunks over MANY frames (for big
  // history, well past the 800ms schedule above). Watch scrollHeight until it
  // stops growing, then re-apply — this is what lets a deep scrolled-up
  // position land once all its rows exist. Re-applies on each growth too so the
  // position tracks in as content streams (no single end-jump), gesture-guarded.
  function reassertWhenSettled(paneId) {
    var h = host(); if (!h) return;
    var lastSH = -1, stable = 0, frames = 0;
    (function step() {
      if (Date.now() - lastGesture < GESTURE_MS) return;   // user took over → stop
      var sh = h.scrollHeight;
      if (sh === lastSH) { if (++stable >= 3) { reassert(paneId, 'settled'); return; } }
      else { stable = 0; lastSH = sh; reassert(paneId, 'growing'); }
      if (++frames < 360) requestAnimationFrame(step);     // ~6s cap
      else reassert(paneId, 'settle-timeout');
    })();
  }

  try {
    tv.on('grid-loaded', function (d) {
      if (d && d.paneId) curPane = d.paneId;
      restore(d && d.paneId);
      scheduleReassert(d && d.paneId);
    });
  } catch (_) {}
  try { tv.on('pane-changed', function (d) { if (d && d.to) curPane = d.to; }); } catch (_) {}
  // Deep-scrollback prefill prepends ABOVE in idle rAF chunks AFTER grid-loaded;
  // watch it settle then re-apply (tail for followers, deep dist for scrolled-up).
  try { tv.on('scrollback-prefill', function (d) {
    reassertWhenSettled((d && d.paneId) || curPane);
  }); } catch (_) {}

  // --- bind gesture + scrollend on the STABLE grid-host scroller ------------
  var tries = 0;
  (function attach() {
    var h = host();
    if (!h) { if (tries++ < 40) setTimeout(attach, 250); return; }   // up to ~10s
    if (h.__mccScrollMemBound) return;
    h.__mccScrollMemBound = true;

    function gesture() { lastGesture = Date.now(); }
    h.addEventListener('wheel', gesture, { passive: true });
    h.addEventListener('touchmove', gesture, { passive: true });

    // scrollend fires once scrolling (incl. touch momentum) fully stops. Only a
    // recent USER gesture makes it count — programmatic restores emit scrollend
    // too, but with no preceding gesture, so they're ignored.
    var fallback = null;
    h.addEventListener('scrollend', function () {
      if (Date.now() - lastGesture < GESTURE_MS) commit('scrollend');
    }, { passive: true });
    // Fallback for any engine that doesn't fire scrollend: debounce on scroll,
    // still gated on a recent gesture so machine churn is excluded.
    h.addEventListener('scroll', function () {
      if (Date.now() - lastGesture > 250) return;
      clearTimeout(fallback);
      fallback = setTimeout(function () { commit('scroll-fallback'); }, 250);
    }, { passive: true });

    // Cold start: the first grid-loaded may predate this handler — restore once.
    var id = activeId();
    if (id) restore(id);
  })();

  // Flush the latest position on the way out so it survives the restart.
  window.addEventListener('pagehide', function () { commit('pagehide'); });
  window.addEventListener('beforeunload', function () { commit('pagehide'); });
})();
