// mobile-cc-kbd-overlay — keep the view still when the soft keyboard
// opens, toggleable in Settings → Keyboard.
//
// The problem ("the whole view bumps up when I tap Message"): by
// default Android Chrome's `interactive-widget` is `resizes-visual` —
// the visual viewport shrinks and the browser scrolls the page up to
// keep the focused field above the keyboard, AND ttyview-core's
// visualViewport `resize` handler re-runs autoFit on the pane. Both
// jolt the UI.
//
// What actually controls this is the viewport-meta `interactive-widget`
// directive. We set it to `overlays-content`: the keyboard then floats
// over the page with NO viewport resize (so autoFit never fires and
// nothing scrolls), and the browser exposes the keyboard geometry via
// env(keyboard-inset-height) + the VirtualKeyboard API's boundingRect.
// We lift the bottom input cluster (#input-row + #input-accessory) by
// that height so the Message box and the quick-key / command rows stay
// visible right above the floating keyboard. The terminal grid keeps
// full height — no re-fit, no jump.
//
// A first attempt set only `navigator.virtualKeyboard.overlaysContent`
// and the device ignored it (diag showed the visual viewport still
// shrank 323px). The meta directive is the load-bearing mechanism;
// the API flag + geometrychange listener are belt-and-suspenders and a
// more precise lift source than the env() var where supported.
//
// Self-instrumenting: ships kbd-ov-* records to the daemon diag log
// (same {t:'diag'} same-origin WS the kbd-diag plugin uses) + mirrors
// to window.ttyviewLog / console, so we can confirm on-device which
// path applied without a tethered debugger.
(function () {
  var tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) return;
  if (window.__mccKbdOverlay) return;          // idempotent across re-evals
  window.__mccKbdOverlay = true;

  var STORAGE = tv.storage('mobile-cc-kbd-overlay');
  var KEY = 'enabled';
  function isOn() {
    var v = STORAGE.get(KEY);
    return v == null ? true : v !== false;     // default ON
  }

  // ---- diag shipper (own same-origin WS; batched) ----------------
  var buf = [], ws = null, SEQ = 0;
  function wsUrl() {
    return (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws';
  }
  function connect() {
    try {
      ws = new WebSocket(wsUrl());
      ws.addEventListener('open', flush);
      ws.addEventListener('close', function () { ws = null; setTimeout(connect, 3000); });
      ws.addEventListener('error', function () { try { ws.close(); } catch (_) {} });
    } catch (_) { setTimeout(connect, 3000); }
  }
  function flush() {
    if (!buf.length || !ws || ws.readyState !== WebSocket.OPEN) return;
    var ev = buf.splice(0, buf.length);
    try { ws.send(JSON.stringify({ t: 'diag', events: ev })); } catch (_) { buf = ev.concat(buf); }
  }
  setInterval(flush, 1000);
  connect();
  function emit(cat, data) {
    var rec = Object.assign({ cat: cat, ts: (function () { try { return Date.now(); } catch (_) { return 0; } })(), seq: ++SEQ }, data || {});
    buf.push(rec);
    if (buf.length >= 16) flush();
    try { if (window.ttyviewLog) window.ttyviewLog(cat, data); } catch (_) {}
    try { console.log('[' + cat + ']', JSON.stringify(data || {})); } catch (_) {}
  }

  // ---- viewport meta (the load-bearing mechanism) ----------------
  var META = document.querySelector('meta[name="viewport"]');
  var ORIG_META = META ? META.getAttribute('content') : null;
  function setMeta(on) {
    if (!META) { emit('kbd-ov-nometa', {}); return; }
    var parts = (ORIG_META || '').split(',').map(function (s) { return s.trim(); })
      .filter(function (s) { return s && !/^interactive-widget=/i.test(s); });
    if (on) parts.push('interactive-widget=overlays-content');
    var next = parts.join(',');
    META.setAttribute('content', next);
    emit('kbd-ov-meta', { on: on, content: next });
  }

  // ---- lift style ------------------------------------------------
  // --mcc-kb-h (set from the VirtualKeyboard boundingRect when
  // available) takes precedence; env(keyboard-inset-height) is the
  // fallback. Either is 0 while the keyboard is hidden → no-op.
  var STYLE_ID = 'mobile-cc-kbd-overlay-style';
  function setStyle(on) {
    var s = document.getElementById(STYLE_ID);
    if (on) {
      if (!s) { s = document.createElement('style'); s.id = STYLE_ID; (document.head || document.documentElement).appendChild(s); }
      // Lift ONLY the Message input row above the keyboard — like every
      // mobile chat app. The tall #input-accessory block (command chips,
      // quick keys, the multi-row pinned tab grid) deliberately stays
      // put and is covered by the keyboard; lifting it too made the
      // whole bottom UI leap upward, which read as the "bump". It
      // reappears in place the moment the keyboard is dismissed.
      s.textContent =
        '#input-row {' +
        ' transition: transform 0.12s ease-out;' +
        ' transform: translateY(calc(-1 * var(--mcc-kb-h, env(keyboard-inset-height, 0px))));' +
        ' }';
    } else if (s) {
      s.remove();
    }
  }

  // ---- VirtualKeyboard API (flag + precise geometry) -------------
  var vk = navigator.virtualKeyboard || null;
  function geom() {
    try {
      var r = vk.boundingRect;
      var h = (r && r.height) ? r.height : 0;
      document.documentElement.style.setProperty('--mcc-kb-h', h + 'px');
      emit('kbd-ov-geom', { h: Math.round(h) });
    } catch (_) {}
  }
  function setVK(on) {
    if (!vk) return;
    try { vk.overlaysContent = on; emit('kbd-ov-vkset', { on: on }); }
    catch (e) { emit('kbd-ov-vkset', { on: on, err: String(e) }); }
    if (on) {
      vk.addEventListener('geometrychange', geom);
    } else {
      vk.removeEventListener('geometrychange', geom);
      document.documentElement.style.removeProperty('--mcc-kb-h');
    }
  }

  // ---- ground-truth check: did the visual viewport still shrink? --
  // If overlay mode took, focusing the textarea should NOT shrink the
  // visual viewport. We log the height around focus so the diag shows
  // whether the fix actually held on this device.
  var vvWired = false;
  function wireVV() {
    if (vvWired || !window.visualViewport) return;
    vvWired = true;
    var last = Math.round(window.visualViewport.height);
    window.visualViewport.addEventListener('resize', function () {
      var h = Math.round(window.visualViewport.height);
      var d = h - last; last = h;
      if (Math.abs(d) < 80) return;
      emit('kbd-ov-vv', { delta: d, height: h, on: isOn() });
    });
  }

  function apply() {
    var on = isOn();
    setVK(on);
    setMeta(on);
    setStyle(on);
    wireVV();
    emit('kbd-ov-apply', { on: on, hasVK: !!vk, hasMeta: !!META });
  }
  apply();

  // ---- don't let the keyboard auto-pop on app resume ------------
  // Android Chrome restores focus to the previously-focused field when
  // the PWA returns to the foreground (app-switch, screen unlock, a
  // glance at a notification), which re-shows the soft keyboard even
  // though the user only switched away and back. The kbd-diag log
  // pinned this: ~11/162 input focuses fired with NO preceding tap,
  // right after `visibility:visible` / lifecycle `resume` — the
  // "switch back and the keyboard is already up; reload fixes it"
  // report. Mirror tmux-web's blur-on-hide guard: drop focus from the
  // Message box when the page is hidden, so there is nothing for Chrome
  // to restore on resume. The draft text stays put (blur doesn't clear
  // the value); the user taps once to resume typing.
  function blurMsgBoxOnHide(reason) {
    var el = document.getElementById('input-text');
    if (!el || document.activeElement !== el) return;
    try { el.blur(); emit('kbd-ov-blur-on-hide', { reason: reason }); }
    catch (e) { emit('kbd-ov-blur-on-hide', { reason: reason, err: String(e) }); }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') blurMsgBoxOnHide('hidden');
  }, { passive: true });
  // Page Lifecycle freeze can fire without a visibilitychange we observe.
  document.addEventListener('freeze', function () { blurMsgBoxOnHide('freeze'); }, { passive: true });

  // ---- Settings → Keyboard toggle --------------------------------
  tv.contributes.settingsTab({
    id: 'mobile-cc-kbd-overlay',
    title: 'Keyboard',
    render: function (container) {
      container.innerHTML = '';

      var intro = document.createElement('p');
      intro.style.cssText = 'color:var(--ttv-muted);font-size:12px;margin:0 0 16px;';
      intro.textContent =
        'Controls how the on-screen keyboard interacts with the page.';
      container.appendChild(intro);

      var label = document.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:10px;color:var(--ttv-fg);font-size:14px;cursor:pointer;';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = isOn();
      cb.style.cssText = 'width:18px;height:18px;flex:none;';
      cb.addEventListener('change', function () {
        STORAGE.set(KEY, cb.checked);
        apply();
      });
      label.appendChild(cb);
      var span = document.createElement('span');
      span.textContent = 'Keep the view still when the keyboard opens';
      label.appendChild(span);
      container.appendChild(label);

      var hint = document.createElement('div');
      hint.style.cssText = 'color:var(--ttv-muted);font-size:11px;margin-top:6px;margin-left:28px;';
      hint.textContent =
        'Makes the keyboard overlay the page instead of pushing everything ' +
        'up and re-fitting the terminal. The Message box + key rows lift to ' +
        'sit just above the keyboard. Needs Chromium (Android Chrome / the ' +
        'installed app); a reload may be needed for a meta change to take ' +
        'full effect.';
      container.appendChild(hint);
    },
  });
})();
