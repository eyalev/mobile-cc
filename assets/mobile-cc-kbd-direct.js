// mobile-cc-kbd-direct — "live keys": type straight into the terminal from a
// phone soft keyboard, one keystroke at a time, instead of composing in the
// Message box and submitting on Enter.
//
// WHY a second keyboard plugin (vs mobile-cc-kbd-passthrough):
//   - kbd-passthrough is DESKTOP-only (gated on a fine pointer). It reads
//     `keydown` and maps `e.key` → terminal bytes. That works for a physical
//     keyboard but NOT for an Android soft keyboard: Gboard fires `keydown`
//     with keyCode 229 / e.key "Unidentified" for printable letters — the real
//     text only arrives via `input`/composition events. (Android's own docs:
//     "never rely on receiving KeyEvents for any key on a soft input method.")
//   - So mobile direct mode captures PRINTABLES via an input field and streams
//     a value-DIFF, and leans on the existing Quick-Keys row for control keys
//     (Esc / Tab / Ctrl-C / arrows). No keydown-for-letters needed.
//
// THE FIELD: a hidden `<input type="password">` inside a `<form>`, overlaid on
// the Message box. type=password is the battle-tested fix (xterm.js #2403/#675)
// for disabling Android predictive text + the "intermediate text layer" that
// makes backspace behave unpredictably — keystrokes land in `.value`
// synchronously so the diff is reliable. Its dots are hidden (color:transparent,
// caret kept) — the TERMINAL is the echo; the field is a pure capture surface.
//
// THE STREAM: on each `input` we diff `.value` against the last-sent baseline
// (common prefix), emit N backspaces (\x7f) for the removed tail + the new
// chars. This survives autocorrect/word-replacement (it backspaces the wrong
// tail and retypes) — the inherent robustness reason for diffing rather than
// trusting per-event deltas. Enter → '\r' (submit) + baseline reset.
//
// RESYNC: the field is a client-side buffer; tab-completion, Quick-Keys, and
// command chips change the terminal line out-of-band, desyncing the baseline.
// We wrap tv.sendInput so ANY external send resets our baseline (clear field),
// and reset on pane switch too. After a reset a bare Backspace still sends one
// \x7f best-effort, so deleting a completion's chars works.
//
// TRADEOFF vs the buffered Message box (kept as the default): you lose
// review-before-send + the cleanest autocorrect, and each keystroke is a WS
// round-trip (visible lag on a slow link — there is no predictive local echo in
// this tier). You GAIN tab-completion, Ctrl-R, single-key prompts, and live
// TUIs (vim/less/REPLs) — none of which work when the shell never sees partial
// input. Off by default; toggle in the input row (⌁) or Settings → Live keys.
(function () {
  var tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) {
    try { console.warn('[mobile-cc-kbd-direct] requires apiVersion 1'); } catch (_) {}
    return;
  }
  if (window.__mccKbdDirect) return;             // idempotent across re-evals
  window.__mccKbdDirect = true;

  var STORAGE = tv.storage('mobile-cc-kbd-direct');
  var KEY = 'enabled';
  function isOn() { return STORAGE.get(KEY) === true; }   // default OFF

  function diag(cat, data) {
    try { if (typeof window.ttvDiag === 'function') window.ttvDiag(cat, data || {}); } catch (_) {}
  }

  // ---- send wrapper: our own sends vs everyone else's --------------------
  // tv.sendInput is the public lane Quick-Keys + command chips use. Wrapping
  // it lets us detect out-of-band input (which changes the terminal line) and
  // resync our baseline. Core's Message-box submit uses a private closure, not
  // this — and it can't fire in live mode anyway (the field is covered).
  var origSend = tv.sendInput.bind(tv);
  var selfSending = false;
  function selfSend(seq) {
    selfSending = true;
    try { return origSend(null, seq); } finally { selfSending = false; }
  }
  tv.sendInput = function (paneId, keys) {
    if (!selfSending && isOn()) resetBaseline('external-input');
    return origSend(paneId, keys);
  };

  // ---- the capture field -------------------------------------------------
  var form = null, input = null, badge = null;
  var prev = '';                                 // baseline = chars already sent

  function commonPrefix(a, b) {
    var n = Math.min(a.length, b.length), i = 0;
    while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
    return i;
  }

  function resetBaseline(reason) {
    prev = '';
    if (input) input.value = '';
    diag('kbd-direct-reset', { reason: reason });
  }

  // Diff the field value against the baseline and stream the change.
  function stream() {
    if (!input || input.__composing) return;     // wait for compositionend
    var cur = input.value;
    if (cur === prev) return;
    var c = commonPrefix(prev, cur);
    var del = prev.length - c;                    // tail to delete
    var add = cur.slice(c);                       // chars to add
    var seq = '';
    for (var i = 0; i < del; i++) seq += '\x7f';
    seq += add;
    if (!seq) { prev = cur; return; }
    var ok = selfSend(seq);
    diag('kbd-direct-stream', { bs: del, add: add.length, ok: !!ok });
    // Only advance the baseline on a confirmed send; on failure keep `prev`
    // so the next input re-diffs and resends (WS reconnecting after an Android
    // background cycle is the common failure).
    if (ok) prev = cur;
  }

  function buildField() {
    if (form) return;
    form = document.createElement('form');
    form.id = 'mcc-direct-form';
    form.setAttribute('autocomplete', 'off');
    form.addEventListener('submit', function (e) { e.preventDefault(); });
    form.style.cssText =
      'position:absolute;inset:0;margin:0;display:none;align-items:stretch;';

    input = document.createElement('input');
    input.id = 'mcc-direct-input';
    input.type = 'password';                      // disables Android predictive text
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('inputmode', 'text');
    input.setAttribute('enterkeyhint', 'enter');
    input.setAttribute('aria-label', 'Live keyboard — types straight into the terminal');
    // Looks like the Message box, but its text is invisible (the terminal is
    // the echo); caret stays visible so it reads as a live field, not a blank.
    input.style.cssText =
      'flex:1;min-width:0;width:100%;height:100%;box-sizing:border-box;' +
      'padding:6px 10px;background:var(--ttv-panel-bg);color:transparent;' +
      'caret-color:var(--ttv-accent,#569cd6);' +
      'border:1px solid var(--ttv-accent,#569cd6);border-radius:6px;' +
      'font-family:ui-monospace,monospace;font-size:14px;line-height:1.4;outline:none;';

    badge = document.createElement('span');
    badge.textContent = 'live → terminal';
    badge.style.cssText =
      'position:absolute;right:10px;top:50%;transform:translateY(-50%);' +
      'pointer-events:none;color:var(--ttv-accent,#569cd6);opacity:.8;' +
      'font:600 11px/1 ui-monospace,monospace;letter-spacing:.02em;';

    input.addEventListener('input', stream);
    input.addEventListener('compositionstart', function () { input.__composing = true; });
    input.addEventListener('compositionend', function () { input.__composing = false; stream(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        selfSend('\r');
        resetBaseline('enter');
        diag('kbd-direct-enter', {});
      } else if (e.key === 'Backspace' && input.value === '' && prev === '') {
        // Field already empty (line start, or just after a resync): nothing to
        // diff. Send one \x7f best-effort so deleting a completion still works.
        e.preventDefault();
        selfSend('\x7f');
        diag('kbd-direct-bs-empty', {});
      }
    });

    form.appendChild(input);
    form.appendChild(badge);
  }

  function mountField(focus) {
    var wrap = document.getElementById('input-wrap');
    if (!wrap) return;
    buildField();
    if (form.parentNode !== wrap) wrap.appendChild(form);
    form.style.display = 'flex';
    resetBaseline('mount');
    if (focus) { try { input.focus({ preventScroll: true }); } catch (_) { try { input.focus(); } catch (e) {} } }
  }

  function unmountField() {
    if (!form) return;
    form.style.display = 'none';
    if (input) { input.value = ''; prev = ''; try { input.blur(); } catch (_) {} }
  }

  // ---- the input-row toggle (⌁) ------------------------------------------
  var toggleBtn = null;
  function paintToggle() {
    if (!toggleBtn) return;
    var on = isOn();
    toggleBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    toggleBtn.style.background = on ? 'var(--ttv-accent,#569cd6)' : 'transparent';
    toggleBtn.style.color = on ? 'var(--ttv-bg-elev,#1b1b1b)' : 'var(--ttv-muted,#888)';
    toggleBtn.style.borderColor = on ? 'var(--ttv-accent,#569cd6)' : 'var(--ttv-control-border,#3a3a3a)';
    toggleBtn.title = on ? 'Live keys ON — typing goes straight to the terminal'
                         : 'Live keys — type straight into the terminal';
  }
  function injectToggle() {
    var row = document.getElementById('input-row');
    if (!row || document.getElementById('mcc-direct-toggle')) return;
    var b = document.createElement('button');
    b.id = 'mcc-direct-toggle';
    b.type = 'button';
    b.tabIndex = -1;                              // never steal Message-box focus
    b.textContent = '⌁';
    b.setAttribute('aria-label', 'Toggle live keyboard');
    b.style.cssText =
      'flex:none;align-self:flex-end;width:36px;min-height:36px;height:36px;' +
      'border:1px solid var(--ttv-control-border,#3a3a3a);border-radius:6px;' +
      'background:transparent;color:var(--ttv-muted,#888);font-size:18px;' +
      'line-height:1;cursor:pointer;font-family:inherit;';
    // pointerup (not click): on Android the touchstart.preventDefault that keeps
    // the field focused also eats the synthetic click (mirrors quickkeys/commands).
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });
    b.addEventListener('pointerup', function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      setOn(!isOn(), true);
    });
    row.insertBefore(b, row.firstChild);
    toggleBtn = b;
    paintToggle();
  }

  // ---- apply / toggle ----------------------------------------------------
  var settingsSyncs = [];                         // checkboxes to keep in sync
  function apply(on, focus) {
    if (on) mountField(focus); else unmountField();
    paintToggle();
    for (var i = 0; i < settingsSyncs.length; i++) {
      try { settingsSyncs[i].checked = on; } catch (_) {}
    }
  }
  function setOn(on, focus) {
    STORAGE.set(KEY, !!on);
    diag('kbd-direct-toggle', { on: !!on });
    apply(!!on, focus);
  }

  // ---- resync on pane switch --------------------------------------------
  try { tv.on('pane-changed', function () { resetBaseline('pane-changed'); }); } catch (_) {}

  // ---- boot --------------------------------------------------------------
  // Wait for the input row to exist, then inject the toggle and (if persisted
  // ON) mount the field WITHOUT auto-focusing — popping the keyboard on every
  // page load would be hostile. The user taps the field / ⌁ to start typing.
  function boot() {
    if (!document.getElementById('input-row') || !document.getElementById('input-wrap')) {
      setTimeout(boot, 300);
      return;
    }
    injectToggle();
    apply(isOn(), false);
  }
  boot();

  // ---- Settings → Live keys ---------------------------------------------
  tv.contributes.settingsTab({
    id: 'mobile-cc-kbd-direct',
    title: 'Live keys',
    render: function (container) {
      container.innerHTML = '';

      var intro = document.createElement('p');
      intro.style.cssText = 'color:var(--ttv-muted);font-size:12px;margin:0 0 16px;';
      intro.textContent =
        'Type straight into the terminal, one keystroke at a time, instead of ' +
        'composing in the Message box and submitting on Enter. Enables ' +
        'tab-completion, Ctrl-R, single-key prompts, and live TUIs (vim, less, ' +
        'REPLs).';
      container.appendChild(intro);

      var label = document.createElement('label');
      label.style.cssText =
        'display:flex;align-items:center;gap:10px;color:var(--ttv-fg);font-size:14px;cursor:pointer;';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = isOn();
      cb.style.cssText = 'width:18px;height:18px;flex:none;';
      cb.addEventListener('change', function () { setOn(cb.checked, false); });
      label.appendChild(cb);
      var span = document.createElement('span');
      span.textContent = 'Live keys — type straight into the terminal';
      label.appendChild(span);
      container.appendChild(label);
      settingsSyncs.push(cb);

      var hint = document.createElement('div');
      hint.style.cssText = 'color:var(--ttv-muted);font-size:11px;margin-top:8px;margin-left:28px;';
      hint.textContent =
        'Toggle anytime with the ⌁ button next to the Message box. Use the ' +
        'Quick-Keys row for Esc / Tab / Ctrl / arrows. The terminal shows what ' +
        'you type (the field stays blank) — so on a slow link each keystroke ' +
        'lags by one round-trip. Off uses the normal compose-then-send box.';
      container.appendChild(hint);
    },
  });
})();
