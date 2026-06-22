// mobile-cc-native-screenshot — one-tap "attach last screenshot" chip.
//
// Only active inside the native Capacitor shell (android-app/). It calls
// the native LastScreenshot plugin, which reads the newest image in the
// device's Screenshots bucket straight from MediaStore (no picker, no
// Syncthing), then feeds it into the EXISTING ttyview-image-paste
// pipeline by dispatching a synthetic `drop` event with a DataTransfer —
// so the queue / thumbnail preview / upload / send-interception all reuse
// image-paste's code unchanged. In a plain browser this plugin is a
// no-op (the chip never renders), so the PWA is untouched.
//
// Touch handling mirrors mobile-cc-commands / ttyview-quickkeys:
// pointerup (Android Chrome eats the synthetic click), tabIndex=-1 +
// mousedown.preventDefault so a tap never blurs the Message box.
(function () {
  var tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) {
    console.warn('[mobile-cc-native-screenshot] requires apiVersion 1');
    return;
  }

  // Gate on the native shell. In a normal browser Capacitor is absent or
  // isNativePlatform() is false → we contribute nothing.
  var cap = window.Capacitor;
  var isNative = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
  if (!isNative) return;

  var LastScreenshot;
  try {
    LastScreenshot = cap.registerPlugin('LastScreenshot');
  } catch (e) {
    console.warn('[mobile-cc-native-screenshot] LastScreenshot plugin missing', e);
    return;
  }

  function flash(msg) {
    try { tv.toast ? tv.toast(msg) : console.log('[mcc-screenshot]', msg); }
    catch (e) { console.log('[mcc-screenshot]', msg); }
  }

  function dataUrlToFile(dataUrl, name, mime) {
    var comma = dataUrl.indexOf(',');
    var b64 = dataUrl.slice(comma + 1);
    var bin = atob(b64);
    var len = bin.length;
    var arr = new Uint8Array(len);
    for (var i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], name || 'screenshot.png', { type: mime || 'image/png' });
  }

  // Hand the File to image-paste via a synthetic drop. image-paste listens
  // on document for 'drop' and reads e.dataTransfer.files.
  function feedToImagePaste(file) {
    var dt = new DataTransfer();
    dt.items.add(file);
    var ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
  }

  var busy = false;
  function grab() {
    if (busy) return;
    busy = true;
    flash('Fetching last screenshot…');
    LastScreenshot.lastScreenshot().then(function (res) {
      busy = false;
      if (!res || !res.dataUrl) { flash('No screenshot found'); return; }
      var file = dataUrlToFile(res.dataUrl, res.name, res.mime);
      feedToImagePaste(file);
      var ageSec = res.takenAt ? Math.max(0, Math.round((Date.now() - res.takenAt) / 1000)) : null;
      flash(ageSec != null ? ('Attached screenshot (' + ageSec + 's ago)') : 'Attached screenshot');
    }).catch(function (err) {
      busy = false;
      var m = (err && (err.message || err.errorMessage)) || String(err);
      flash('Screenshot failed: ' + m);
      console.warn('[mobile-cc-native-screenshot]', err);
    });
  }

  tv.contributes.inputAccessory({
    id: 'mobile-cc-native-screenshot',
    name: 'Last Screenshot',
    preferredSlot: 'input-left',
    render: function (slot) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.tabIndex = -1;                 // not focusable → tap keeps textarea focus
      btn.title = 'Attach last screenshot';
      // Camera-with-clock glyph: "the most recent capture".
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><path d="M3 7h3l1.5-2h9L18 7h3v12H3z"/><circle cx="12" cy="13" r="3.2"/><path d="M12 11.6v1.6l1 0.8"/></svg>';
      btn.style.color = 'var(--ttv-accent)';
      btn.addEventListener('pointerup', function (e) {
        if (e.button !== undefined && e.button !== 0) return;
        grab();
      });
      // Cancel desktop focus-on-mousedown (touch path is covered by tabIndex=-1).
      btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
      slot.appendChild(btn);
      return function unmount() { btn.remove(); };
    },
  });
})();
