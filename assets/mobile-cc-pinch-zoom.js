// mobile-cc-pinch-zoom — pinch to zoom the terminal area. Two modes,
// chosen in Settings → Pinch Zoom; both are purely client-side (no tmux
// resize → no window-size bounce).
//
//   • "sharp"  — pinch changes the terminal FONT SIZE. Crisp (the grid
//     re-renders), and horizontal panning is enabled so text that runs
//     past the screen edge is reachable by swiping. Native browser zoom
//     is off (user-scalable=no), so we drive --ttv-font-size ourselves.
//   • "smooth" — pinch applies a CSS transform: scale() to #grid-host,
//     like zooming an image: buttery, GPU-smooth, drag to pan. Text gets
//     slightly soft at high zoom. #grid-host is wrapped in an
//     overflow:hidden clip so the scaled terminal can't spill over the
//     header/controls. We wrap the STABLE #grid-host element (not the
//     cell-grid's volatile #sb-host/#primary-host children, which get
//     recreated on every pane switch).
//   • "off"    — no pinch handling.
//
// Double-tap with one finger resets zoom (font→fit, or scale→1×).
// Mode persists (mobile-cc-pinch-zoom.mode); default "sharp".
(function () {
  var tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) return;
  if (window.__mccPinchZoom) return;
  window.__mccPinchZoom = true;

  var STORAGE = tv.storage('mobile-cc-pinch-zoom');
  var MODE_KEY = 'mode';
  var FONT_MIN = 8, FONT_MAX = 40, SCALE_MIN = 1, SCALE_MAX = 4;

  function mode() {
    var v = STORAGE.get(MODE_KEY);
    return (v === 'off' || v === 'sharp' || v === 'smooth') ? v : 'sharp';
  }
  function host() { return document.getElementById('grid-host'); }

  // ---- shared gesture state --------------------------------------
  var bound = false, pinch = null;       // pinch = {startDist, startVal, mx, my}
  var scale = 1, tx = 0, ty = 0;         // smooth-mode transform
  var panning = null;                    // smooth-mode 1-finger pan {x,y}
  var lastTap = 0;

  function dist(t) {
    var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY;
    return Math.hypot(dx, dy);
  }
  function midRel(t, rect) {
    return {
      x: (t[0].clientX + t[1].clientX) / 2 - rect.left,
      y: (t[0].clientY + t[1].clientY) / 2 - rect.top,
    };
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // ---- sharp (font-size) -----------------------------------------
  function curFont() {
    var v = parseFloat(getComputedStyle(host()).fontSize);
    return v > 0 ? v : 12;
  }
  function applyFont(px) {
    px = clamp(Math.round(px), FONT_MIN, FONT_MAX);
    document.documentElement.style.setProperty('--ttv-font-size', px + 'px');
    try { localStorage.setItem('ttv-font-size', String(px)); } catch (_) {}
    // Manual zoom = stop auto-fit from snapping the font back (same as A±).
    try { localStorage.setItem('ttv-autofit', 'false'); } catch (_) {}
  }
  function resetFont() {
    var b = document.getElementById('font-fit');     // re-fit to viewport
    if (b) { try { localStorage.setItem('ttv-autofit', 'true'); b.click(); } catch (_) {} }
  }

  // ---- smooth (transform scale) ----------------------------------
  function ensureClip() {
    var h = host(); if (!h) return null;
    if (h.parentNode && h.parentNode.id === 'mcc-zoom-clip') return h.parentNode;
    var clip = document.createElement('div');
    clip.id = 'mcc-zoom-clip';
    clip.style.cssText = 'flex:1;min-height:0;overflow:hidden;position:relative;display:flex;flex-direction:column;';
    h.parentNode.insertBefore(clip, h);
    clip.appendChild(h);
    h.style.flex = '1';
    h.style.transformOrigin = '0 0';
    h.style.willChange = 'transform';
    return clip;
  }
  function removeClip() {
    var clip = document.getElementById('mcc-zoom-clip');
    var h = host();
    if (h) { h.style.transform = ''; h.style.transformOrigin = ''; h.style.willChange = ''; }
    if (clip && clip.parentNode && h) {
      clip.parentNode.insertBefore(h, clip);
      clip.remove();
    }
  }
  function applyTransform() {
    var h = host(); if (!h) return;
    if (scale <= 1.001) { scale = 1; tx = 0; ty = 0; h.style.transform = ''; return; }
    h.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
  }
  // Zoom toward (px,py) in host-local coords, keeping that point fixed.
  function setScale(s1, px, py) {
    s1 = clamp(s1, SCALE_MIN, SCALE_MAX);
    var cx = (px - tx) / scale, cy = (py - ty) / scale;
    tx = px - s1 * cx; ty = py - s1 * cy; scale = s1;
    applyTransform();
  }
  function resetScale() { scale = 1; tx = 0; ty = 0; applyTransform(); }

  // ---- gesture handlers ------------------------------------------
  function onStart(e) {
    var m = mode();
    if (e.touches.length === 2) {
      var h = host(); if (!h) return;
      var rect = h.getBoundingClientRect();
      pinch = { startDist: dist(e.touches), startVal: m === 'smooth' ? scale : curFont(), mid: midRel(e.touches, rect) };
      panning = null;
      e.preventDefault();
    } else if (e.touches.length === 1) {
      // double-tap → reset
      var now = e.timeStamp || (window.performance && performance.now()) || 0;
      if (now - lastTap < 320) { if (m === 'smooth') resetScale(); else resetFont(); lastTap = 0; e.preventDefault(); return; }
      lastTap = now;
      // smooth-mode pan only while zoomed in
      if (m === 'smooth' && scale > 1) {
        panning = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }
    }
  }
  function onMove(e) {
    var m = mode();
    if (pinch && e.touches.length === 2) {
      e.preventDefault();
      var ratio = dist(e.touches) / (pinch.startDist || 1);
      if (m === 'smooth') setScale(pinch.startVal * ratio, pinch.mid.x, pinch.mid.y);
      else applyFont(pinch.startVal * ratio);
    } else if (panning && m === 'smooth' && e.touches.length === 1 && scale > 1) {
      e.preventDefault();
      var t = e.touches[0];
      tx += t.clientX - panning.x; ty += t.clientY - panning.y;
      panning.x = t.clientX; panning.y = t.clientY;
      applyTransform();
    }
  }
  function onEnd(e) {
    if (e.touches.length < 2) pinch = null;
    if (e.touches.length === 0) panning = null;
  }

  function bind() {
    if (bound) return;
    var h = host(); if (!h) return;
    h.addEventListener('touchstart', onStart, { passive: false });
    h.addEventListener('touchmove', onMove, { passive: false });
    h.addEventListener('touchend', onEnd, { passive: false });
    h.addEventListener('touchcancel', onEnd, { passive: false });
    bound = true;
  }
  function unbind() {
    var h = host(); if (!h || !bound) { bound = false; return; }
    h.removeEventListener('touchstart', onStart);
    h.removeEventListener('touchmove', onMove);
    h.removeEventListener('touchend', onEnd);
    h.removeEventListener('touchcancel', onEnd);
    bound = false;
  }

  // ---- apply the active mode -------------------------------------
  var PAN_STYLE_ID = 'mcc-pinch-panstyle';
  function setPanStyle(on) {
    var s = document.getElementById(PAN_STYLE_ID);
    if (on) {
      if (!s) { s = document.createElement('style'); s.id = PAN_STYLE_ID; document.head.appendChild(s); }
      // Allow both-axis panning so zoomed-wide text is reachable.
      s.textContent = '#grid-host { touch-action: pan-x pan-y !important; }';
    } else if (s) { s.remove(); }
  }
  function applyMode() {
    var m = mode();
    if (m === 'off') { unbind(); removeClip(); setPanStyle(false); return; }
    if (m === 'sharp') { removeClip(); setPanStyle(true); bind(); }
    else if (m === 'smooth') { setPanStyle(false); ensureClip(); bind(); }
  }
  // Re-apply on pane switch (smooth clip survives, but rebind defensively).
  try { tv.on('pane-changed', function () { setTimeout(applyMode, 200); }); } catch (_) {}
  setTimeout(applyMode, 600);

  // ---- Settings → Pinch Zoom -------------------------------------
  tv.contributes.settingsTab({
    id: 'mobile-cc-pinch-zoom',
    title: 'Pinch Zoom',
    render: function (container) {
      container.innerHTML = '';
      var intro = document.createElement('p');
      intro.style.cssText = 'color:var(--ttv-muted);font-size:12px;margin:0 0 14px;';
      intro.textContent = 'Pinch the terminal to zoom. Double-tap to reset. Purely visual — the tmux pane is never resized.';
      container.appendChild(intro);

      var OPTS = [
        { v: 'sharp', label: 'Sharp (font size)', hint: 'Pinch changes the font; text stays crisp. Swipe sideways to reach text past the edge.' },
        { v: 'smooth', label: 'Smooth (scale)', hint: 'Pinch scales the view like an image; buttery, drag to pan. Slightly soft at high zoom.' },
        { v: 'off', label: 'Off', hint: 'No pinch zoom.' },
      ];
      OPTS.forEach(function (o) {
        var row = document.createElement('label');
        row.style.cssText = 'display:flex;align-items:flex-start;gap:10px;margin-bottom:12px;cursor:pointer;';
        var rb = document.createElement('input');
        rb.type = 'radio'; rb.name = 'mcc-pz'; rb.checked = (mode() === o.v);
        rb.style.cssText = 'width:18px;height:18px;flex:none;margin-top:1px;';
        rb.addEventListener('change', function () {
          if (!rb.checked) return;
          STORAGE.set(MODE_KEY, o.v);
          // Leaving pinch zoom must not strand the terminal: clear any residual
          // transform/font and restore auto-fit (sharp-mode pinch set
          // ttv-autofit='false'), else 'off' would freeze the view shrunk with
          // auto-fit disabled across reloads. Done here (the explicit switch),
          // not in applyMode, so a pane-change re-apply of 'off' won't fight A±.
          if (o.v === 'off') { resetScale(); resetFont(); }
          applyMode();
        });
        row.appendChild(rb);
        var txt = document.createElement('div');
        var t = document.createElement('div');
        t.textContent = o.label; t.style.cssText = 'color:var(--ttv-fg);font-size:14px;';
        var h = document.createElement('div');
        h.textContent = o.hint; h.style.cssText = 'color:var(--ttv-muted);font-size:11px;margin-top:2px;';
        txt.appendChild(t); txt.appendChild(h); row.appendChild(txt);
        container.appendChild(row);
      });
    },
  });
})();
