// mobile-cc-push — Web Push opt-in + notification deep-link.
//
// The phone buzzes when CC needs you (permission prompt) and, opt-in, when
// a pane goes idle after working. This plugin owns the CLIENT half:
//   • Settings → Notifications: enable (asks permission only on tap, never
//     auto), idle toggle, test, unsubscribe; talks to the daemon's
//     /api/push/* (src/push.rs).
//   • Deep link: a notification tap lands on the right pane — reads
//     ?pane=%N on load and handles the SW's 'mcc-focus-pane' postMessage
//     when the PWA is already open.
//
// Requires a secure context (HTTPS) for Push — the tailnet host qualifies;
// plain http://…:7800 loopback does not (the UI degrades gracefully).
// Design notes: .claude/web-push-design.md.
(function () {
  var tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) {
    console.warn('[mobile-cc-push] requires apiVersion 1');
    return;
  }
  var ACCENT = 'var(--ttv-rail-accent, #569cd6)';

  // ---- deep link: notification tap → focus pane -------------------------
  function selectPaneById(paneId) {
    if (!paneId) return;
    var panes = (tv.listPanes && tv.listPanes()) || [];
    var hit = panes.filter(function (p) { return p.id === paneId; })[0];
    if (hit) tv.selectPane(hit.id);
  }
  function paneFromUrl(url) {
    try {
      var u = new URL(url, location.origin);
      return u.searchParams.get('pane');
    } catch (e) { return null; }
  }
  // On a cold open from a notification: ?pane=%N in the launch URL.
  try {
    var p0 = new URLSearchParams(location.search).get('pane');
    if (p0) setTimeout(function () { selectPaneById(p0); }, 400);
  } catch (e) {}
  // On a warm open (PWA already running): the SW posts here.
  navigator.serviceWorker && navigator.serviceWorker.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'mcc-focus-pane') {
      selectPaneById(paneFromUrl(e.data.url));
    }
  });

  // ---- subscription helpers --------------------------------------------
  function urlB64ToUint8(b64) {
    var pad = '='.repeat((4 - (b64.length % 4)) % 4);
    var s = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(s);
    var arr = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }
  function supported() {
    return 'serviceWorker' in navigator &&
           'PushManager' in window &&
           'Notification' in window &&
           window.isSecureContext;
  }
  async function currentSub() {
    var reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }
  async function enable() {
    var perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Permission ' + perm);
    var keyResp = await fetch('/api/push/vapid-key').then(function (r) { return r.json(); });
    var reg = await navigator.serviceWorker.ready;
    var sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToUint8(keyResp.publicKey),
    });
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub.toJSON()),
    });
  }
  async function disable() {
    var sub = await currentSub();
    if (sub) {
      await fetch('/api/push/unsubscribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      }).catch(function () {});
      await sub.unsubscribe().catch(function () {});
    }
  }

  // ---- settings tab -----------------------------------------------------
  tv.contributes.settingsTab({
    id: 'mobile-cc-push',
    title: 'Notifications',
    render: function (container) {
      container.innerHTML = '';
      var intro = document.createElement('p');
      intro.style.cssText = 'color:var(--ttv-muted);font-size:12px;margin:0 0 12px;line-height:1.5;';
      intro.innerHTML = 'Get a phone notification when <b>Claude needs permission</b> ' +
        '(and, optionally, when a pane goes idle after working). Tapping it opens that pane.';
      container.appendChild(intro);

      var statusLine = document.createElement('div');
      statusLine.style.cssText = 'font-size:12px;margin:0 0 12px;color:var(--ttv-fg);';
      container.appendChild(statusLine);

      if (!supported()) {
        statusLine.innerHTML = '<span style="color:' + ACCENT + ';">Push needs an HTTPS ' +
          'connection.</span> Open mobile-cc over your tailnet HTTPS host (not plain ' +
          'http://…:7800) and install it to the home screen.';
        return;
      }

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.style.cssText = 'padding:8px 14px;border-radius:8px;border:1px solid ' + ACCENT +
        ';background:' + ACCENT + ';color:#1b1b1b;font-weight:700;font-size:13px;cursor:pointer;font-family:inherit;';
      container.appendChild(btn);

      var idleWrap = document.createElement('label');
      idleWrap.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:14px;font-size:13px;color:var(--ttv-fg);cursor:pointer;';
      var idleCb = document.createElement('input');
      idleCb.type = 'checkbox';
      idleWrap.appendChild(idleCb);
      idleWrap.appendChild(document.createTextNode('Also notify when a pane goes idle after working (60s)'));
      container.appendChild(idleWrap);

      var testBtn = document.createElement('button');
      testBtn.type = 'button';
      testBtn.textContent = 'Send test notification';
      testBtn.style.cssText = 'display:block;margin-top:14px;padding:6px 12px;border-radius:8px;border:1px solid var(--ttv-border,#3a3a3a);background:transparent;color:var(--ttv-fg);font-size:12px;cursor:pointer;font-family:inherit;';
      container.appendChild(testBtn);

      var subscribed = false;
      function paint() {
        btn.textContent = subscribed ? 'Disable notifications' : 'Enable notifications';
        idleWrap.style.display = subscribed ? 'flex' : 'none';
        testBtn.style.display = subscribed ? 'block' : 'none';
      }
      async function refresh() {
        var sub = await currentSub().catch(function () { return null; });
        subscribed = !!sub;
        var st = await fetch('/api/push/status').then(function (r) { return r.json(); }).catch(function () { return {}; });
        idleCb.checked = !!st.idleEnabled;
        statusLine.textContent = subscribed
          ? 'Enabled on this device.'
          : 'Notifications are off.';
        paint();
      }

      btn.onclick = async function () {
        btn.disabled = true;
        try {
          if (subscribed) { await disable(); } else { await enable(); }
          await refresh();
        } catch (e) {
          statusLine.innerHTML = '<span style="color:' + ACCENT + ';">' + (e && e.message || 'Failed') + '</span>';
        }
        btn.disabled = false;
      };
      idleCb.onchange = function () {
        fetch('/api/push/settings', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idle_enabled: idleCb.checked }),
        }).catch(function () {});
      };
      testBtn.onclick = function () {
        testBtn.disabled = true;
        fetch('/api/push/test', { method: 'POST' })
          .then(function (r) { return r.json(); })
          .then(function (d) { statusLine.textContent = 'Test sent to ' + (d.sent || 0) + ' device(s).'; })
          .catch(function () {})
          .then(function () { testBtn.disabled = false; });
      };

      refresh();
    },
  });
})();
