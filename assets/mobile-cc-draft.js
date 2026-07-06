// mobile-cc-draft — never lose a typed-but-unsent message.
//
// The #input-text Message box is cleared on a confirmed send, and its DOM
// value is gone on a page reload / PWA relaunch. With the immediate-bake
// policy restarting the daemon often (and the phone reconnecting), a draft you
// were typing could vanish. This persists it.
//
//   (1) SAVE: on input (debounced ~300ms), write the value to localStorage
//       keyed PER-SESSION (each tab's draft is separate). Raw localStorage —
//       NOT tv.storage — because tv.storage is server-synced and a daemon
//       restart is exactly what we're surviving; localStorage is browser-side
//       and persists across restart + reload.
//   (2) RESTORE: on load / grid-loaded / pane-changed, fill the box from the
//       saved draft — but only when it's EMPTY, so a newer thing you've already
//       typed is never clobbered, and only for the CURRENT session's key.
//   (3) CLEAR: after a send, if the box emptied (= confirmed send), drop the
//       saved draft; if the send FAILED (box kept), the draft stays.
//
// Keyed by SESSION name (stable across tmux pane-id reassignment on restart),
// mirroring how core persists ttv-last-session.
(function () {
  var tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) {
    console.warn('[mobile-cc-draft] requires apiVersion 1');
    return;
  }
  var PREFIX = 'mcc-draft:';

  function diag(cat, data) { try { if (typeof window.ttvDiag === 'function') window.ttvDiag(cat, data); } catch (e) {} }
  function inputEl() { return document.getElementById('input-text'); }
  function session() {
    try { var p = tv.getActivePane && tv.getActivePane(); return (p && p.session) || null; } catch (e) { return null; }
  }
  function keyFor(s) { return s ? PREFIX + s : null; }
  function getDraft(s) { try { return localStorage.getItem(keyFor(s)) || ''; } catch (e) { return ''; } }
  function setDraft(s, v) {
    try {
      var k = keyFor(s); if (!k) return;
      if (v && v.trim()) localStorage.setItem(k, v);   // skip empty / whitespace-only
      else localStorage.removeItem(k);
    } catch (e) {}
  }

  // ---- save (debounced; captures the session at SCHEDULE time so a switch
  // mid-debounce can't write the text under the wrong pane) ----------------
  var t = null, pending = null;
  function scheduleSave() {
    var el = inputEl(); if (!el) return;
    pending = { s: session(), v: el.value };
    if (t) clearTimeout(t);
    t = setTimeout(function () {
      if (pending) { setDraft(pending.s, pending.v); diag('mcc-draft-save', { len: (pending.v || '').length }); }
      pending = null; t = null;
    }, 300);
  }

  // ---- restore (only into an EMPTY box, only the current session's draft) --
  function restore() {
    var el = inputEl(); if (!el) return;
    if (el.value && el.value.length) return;       // user already has text → don't clobber
    var s = session(); if (!s) return;
    var d = getDraft(s);
    if (!d) return;
    el.value = d;
    // let core resize the textarea + show the clear-× (and re-save, idempotent)
    try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
    diag('mcc-draft-restore', { session: s, len: d.length });
  }

  // ---- clear-on-send -----------------------------------------------------
  // submitInput() clears the box programmatically on a CONFIRMED send (no
  // 'input' event fires for that). So after a send attempt, check the box:
  // empty → send went through → drop the draft; non-empty → send failed (kept)
  // → persist it so a retry after reload still has it.
  function afterSend() {
    setTimeout(function () {
      var el = inputEl(); if (!el) return;
      var s = session();
      if (!el.value || !el.value.trim()) { setDraft(s, ''); diag('mcc-draft-clear', { session: s }); }
      else setDraft(s, el.value);
    }, 0);
  }

  // ---- wiring ------------------------------------------------------------
  var wired = false;
  function wire() {
    var el = inputEl(); if (!el) return false;
    el.addEventListener('input', scheduleSave);
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) afterSend();
    });
    var send = document.getElementById('send-btn');
    if (send) send.addEventListener('click', afterSend);
    // Core's clear-× empties the box via `value = ''` WITHOUT firing an
    // 'input' event, so scheduleSave never sees the clear and the saved draft
    // survives — then restore() refills it on the next tab switch. Drop the
    // draft explicitly when the user taps clear-×.
    var clear = document.getElementById('input-clear');
    if (clear) clear.addEventListener('click', function () {
      var s = session(); setDraft(s, ''); diag('mcc-draft-clear-x', { session: s });
    });
    return true;
  }

  function tick() {
    if (!wired && wire()) wired = true;
    if (wired) restore();
    return wired;
  }
  var n = 0;
  var iv = setInterval(function () { if (tick() || ++n > 80) clearInterval(iv); }, 150);
  tick();

  // Core swaps the box to the new pane's in-memory draft on switch; if that's
  // empty but localStorage has one for this session, fill it.
  try { tv.on('pane-changed', function () { setTimeout(restore, 0); }); } catch (e) {}
  // grid-loaded fires after the initial pane loads + after a reconnect re-render
  // → the load-time restore path.
  try { tv.on('grid-loaded', function () { setTimeout(restore, 0); }); } catch (e) {}
  diag('mcc-draft-init', {});
})();
