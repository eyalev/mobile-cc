// mobile-cc-scrollback — Settings → Scrollback control for how much
// terminal history mobile-cc keeps and loads.
//
// Two limits govern scrollback (see ttyview-core):
//   1. Daemon retention cap — how many scrolled-off lines the daemon
//      keeps per pane. mobile-cc's binary sets this high (10_000) so
//      there's headroom; not user-tunable from here.
//   2. Hydrate backfill — how many of those lines the client fetches
//      when a pane opens or reconnects (`loadGrid` reads the
//      `ttv-scrollback-rows` localStorage key; ttyview-core falls back
//      to 200, but mobile-cc seeds 2000 on first visit — see below).
//      THIS is what the control below sets: raise it to scroll further
//      back on open, lower it if a fresh open feels slow on an old phone.
//
// The value is a plain `ttv-` localStorage key (not plugin-scoped)
// because ttyview-core's loadGrid consumes it directly — same pattern
// as ttv-active-theme / ttv-active-view. Changing it re-fetches the
// active pane's grid so the new depth applies without a reload.
(function () {
  var tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) return;
  if (window.__mccScrollback) return;            // idempotent across re-evals
  window.__mccScrollback = true;

  var KEY = 'ttv-scrollback-rows';
  var DEFAULT = 2000;                            // mobile-cc's deeper default (core falls back to 200)
  var MIN = 50;
  var MAX = 10000;                               // matches the daemon cap mcc sets

  // Seed the backfill depth on first visit. ttyview-core's loadGrid falls
  // back to 200 when ttv-scrollback-rows is unset; mobile-cc prefers a
  // deeper 2000-line default so scrolling back Just Works on a phone.
  // One-time, key-absence guarded — never overrides a user's own choice.
  try {
    if (localStorage.getItem(KEY) === null) localStorage.setItem(KEY, String(DEFAULT));
  } catch (e) {}

  function current() {
    try {
      var v = parseInt(localStorage.getItem(KEY), 10);
      if (Number.isFinite(v) && v >= 0) return v;
    } catch (e) {}
    return DEFAULT;
  }
  function clamp(v) {
    if (!Number.isFinite(v)) return DEFAULT;
    return Math.max(MIN, Math.min(MAX, Math.round(v)));
  }
  function save(v) {
    try { localStorage.setItem(KEY, String(v)); } catch (e) {}
    // Re-fetch the active pane's grid so the new backfill applies now.
    // loadGrid is a ttyview-core global; guard in case the platform
    // ever renames it.
    try {
      var pane = tv.getActivePane && tv.getActivePane();
      if (pane && pane.id && typeof window.loadGrid === 'function') {
        window.loadGrid(pane.id);
      }
    } catch (e) {}
  }

  tv.contributes.settingsTab({
    id: 'mobile-cc-scrollback',
    title: 'Scrollback',
    render: function (container) {
      container.innerHTML = '';

      var intro = document.createElement('p');
      intro.style.cssText = 'color:var(--ttv-muted);font-size:12px;margin:0 0 16px;';
      intro.textContent =
        'How many lines of terminal history load when you open a pane. ' +
        'Raise it to scroll further back; lower it if a fresh open feels ' +
        'slow on an older phone.';
      container.appendChild(intro);

      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:12px;margin-bottom:10px;';

      var slider = document.createElement('input');
      slider.type = 'range';
      slider.min = String(MIN);
      slider.max = String(MAX);
      slider.step = '50';
      slider.value = String(clamp(current()));
      slider.style.cssText = 'flex:1;accent-color:var(--ttv-accent);';

      var num = document.createElement('input');
      num.type = 'number';
      num.min = String(MIN);
      num.max = String(MAX);
      num.step = '50';
      num.value = String(clamp(current()));
      num.style.cssText =
        'width:80px;flex:none;background:var(--ttv-bg-elev2);color:var(--ttv-fg);' +
        'border:1px solid var(--ttv-border);border-radius:6px;padding:6px 8px;font-size:14px;';

      var unit = document.createElement('span');
      unit.textContent = 'lines';
      unit.style.cssText = 'color:var(--ttv-muted);font-size:13px;flex:none;';

      // Keep slider + number in sync; commit on change, not every input
      // tick, so we don't re-fetch the grid mid-drag.
      function reflect(v) {
        slider.value = String(v);
        num.value = String(v);
      }
      slider.addEventListener('input', function () { num.value = slider.value; });
      slider.addEventListener('change', function () {
        var v = clamp(parseInt(slider.value, 10));
        reflect(v); save(v);
      });
      num.addEventListener('change', function () {
        var v = clamp(parseInt(num.value, 10));
        reflect(v); save(v);
      });

      row.appendChild(slider);
      row.appendChild(num);
      row.appendChild(unit);
      container.appendChild(row);

      var presetRow = document.createElement('div');
      presetRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;';
      [200, 1000, 2000, 5000, 10000].forEach(function (p) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = String(p);
        b.style.cssText =
          'background:var(--ttv-bg-elev2);color:var(--ttv-fg);border:1px solid var(--ttv-border);' +
          'border-radius:6px;padding:6px 12px;font-size:13px;cursor:pointer;';
        b.addEventListener('click', function () {
          var v = clamp(p);
          reflect(v); save(v);
        });
        presetRow.appendChild(b);
      });
      container.appendChild(presetRow);

      var hint = document.createElement('div');
      hint.style.cssText = 'color:var(--ttv-muted);font-size:11px;line-height:1.5;';
      hint.textContent =
        'The daemon keeps up to ' + MAX + ' lines per pane, so that’s the ' +
        'ceiling. Live output past the loaded window still streams in as it ' +
        'happens — this only affects how far back the initial load reaches. ' +
        'Takes effect immediately on the open pane.';
      container.appendChild(hint);
    },
  });
})();
