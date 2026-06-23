// mobile-cc-tab-menu — a per-tab ⋮ that opens a manage menu (Rename / Kill)
// right on the tab, so closing a session doesn't mean digging into the pane
// picker. Move-to-group is a planned addition.
//
// Why ⋮ and not long-press: ttyview-tabs already binds long-press on tabs
// (todo/done mark cycling), so a long-press menu would collide. A small ⋮
// tap target (stopPropagation) doesn't.
//
// Coordination-safe: no ttyview-core edits. The ⋮ is DOM-injected into each
// tab and re-injected after the tab area re-renders (MutationObserver + a slow
// interval backstop). Actions hit the existing /api/sessions endpoints.
(function () {
  var tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) return;

  // ---- api ----
  async function apiKill(name) {
    var res = await fetch('/api/sessions/' + encodeURIComponent(name), { method: 'DELETE' });
    if (!res.ok) { var j = await res.json().catch(function () { return {}; }); throw new Error(j.error || ('HTTP ' + res.status)); }
    return res.json().catch(function () { return {}; });
  }
  async function apiRename(from, to) {
    var res = await fetch('/api/sessions/' + encodeURIComponent(from) + '/rename', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: to }),
    });
    if (!res.ok) { var j = await res.json().catch(function () { return {}; }); throw new Error(j.error || ('HTTP ' + res.status)); }
    return res.json().catch(function () { return {}; });
  }

  function sanitize(s) { return (s || '').trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, ''); }

  function flash(msg, bad) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText =
      'position:fixed;left:50%;bottom:80px;transform:translateX(-50%);z-index:1200;' +
      'background:' + (bad ? '#7a2230' : '#2d3a4a') + ';color:#fff;border:1px solid ' + (bad ? '#a83b4a' : '#41597a') + ';' +
      'border-radius:8px;padding:8px 12px;font-size:13px;max-width:80vw;box-shadow:0 6px 24px rgba(0,0,0,.5);';
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3500);
  }

  // ---- projects (groups are derived from session names) ----
  // Mirrors ttyview-tabs' deriveGroup: `<group>(-claude|-cc|-agent)?<digits>`.
  function deriveGroup(session) {
    var m = /^([a-zA-Z][\w.-]*?)(?:[-_](?:claude|cc|agent))?[-_]?(\d+)$/.exec(session || '');
    return m ? m[1] : null;
  }
  function existingNames() {
    var s = {}; (tv.listPanes() || []).forEach(function (p) { s[p.session] = 1; }); return s;
  }
  function getGroups() {
    var set = {};
    (tv.listPanes() || []).forEach(function (p) { var g = deriveGroup(p.session); if (g) set[g] = 1; });
    return Object.keys(set).sort();
  }
  // Lowest free `<base><N>` (base e.g. "api-claude").
  function numberedName(base) {
    var names = existingNames();
    for (var i = 1; i < 999; i++) { if (!names[base + i]) return base + i; }
    return base + Date.now();
  }
  // When "Move to project" renames a session, the EXISTING pin still points at
  // the OLD name. tmux keeps the pane id, but ttyview-tabs' resolvePin rejects
  // an id whose session changed (its anti-id-recycling guard), so the old pin
  // goes stale → renders as a dead "missing" tab and the moved session isn't
  // grouped (the exact "move failed" symptom). Migrate the pin (+ its subtitle
  // and todo/done mark) onto the new name, keep the pane id, and collapse any
  // duplicate pin on that pane. Persisted to ttyview-tabs storage; a reload
  // makes ttyview-tabs reload pins (it caches them in memory at init).
  function migratePinAndMeta(from, to) {
    try {
      var st = tv.storage('ttyview-tabs');
      var pane = (tv.listPanes() || []).find(function (x) { return x.session === to; });
      var newId = pane ? pane.id : null;
      var pins = st.get('pins'); if (!Array.isArray(pins)) pins = [];
      var out = [], migrated = false;
      for (var i = 0; i < pins.length; i++) {
        var pin = pins[i] || {};
        var hit = pin.session === from || (newId && pin.id === newId);
        if (hit) {
          if (migrated) continue;            // drop duplicate pins on this pane
          migrated = true;
          pin.session = to; if (newId) pin.id = newId;
        }
        out.push(pin);
      }
      st.set('pins', out);
      ['labels', 'marks'].forEach(function (k) {
        var m = st.get(k);
        if (m && m[from] != null) { m[to] = m[from]; delete m[from]; st.set(k, m); }
      });
    } catch (e) {}
  }

  // Move = rename so the name groups under <project> (grouping is name-based).
  function moveToProject(session, project) {
    var to = numberedName(project + '-claude');
    apiRename(session, to)
      .then(function () { return tv.refreshPanes(); })
      .then(function () {
        migratePinAndMeta(session, to);     // pin + subtitle/mark follow the rename
        flash('Moved to ' + project + ' (' + to + ') — refreshing…');
        // ttyview-tabs caches pins in memory; reload so the moved tab re-pins
        // and groups under the project on the fresh render.
        setTimeout(function () { try { location.reload(); } catch (e) {} }, 500);
      })
      .catch(function (e) { flash('Move failed: ' + e.message, true); });
  }
  // Remove a session from the tabs "recents" MRU. The tabs plugin caches
  // recents in memory, so a reload is needed for the recent row to reflect it.
  function removeFromRecents(session) {
    try {
      var s = tv.storage('ttyview-tabs');
      var r = s.get('recents');
      if (Array.isArray(r)) s.set('recents', r.filter(function (x) { return x !== session; }));
    } catch (e) {}
    flash('Removed from recents — refreshing…');
    setTimeout(function () { try { location.reload(); } catch (e) {} }, 450);
  }

  function mkBtn(label, onTap, danger) {
    var b = document.createElement('button');
    b.type = 'button'; b.tabIndex = -1; b.textContent = label;
    b.style.cssText =
      'min-width:34px;height:32px;padding:0 12px;border:1px solid var(--ttv-border,#3a3a3a);' +
      'border-radius:6px;background:transparent;color:' + (danger ? '#fff' : 'var(--ttv-fg)') + ';font-size:14px;' +
      'cursor:pointer;font-family:inherit;line-height:1;';
    if (danger) { b.style.background = '#a83b4a'; b.style.borderColor = 'transparent'; }
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });
    b.addEventListener('click', onTap);
    return b;
  }

  // ---- manage menu ----
  var menu = null, outside = null;
  function closeMenu() {
    if (menu) { menu.remove(); menu = null; }
    if (outside) { document.removeEventListener('pointerdown', outside, true); outside = null; }
  }
  function menuItem(title, onTap, danger) {
    var b = document.createElement('button');
    b.type = 'button'; b.tabIndex = -1; b.textContent = title;
    b.style.cssText =
      'display:block;width:100%;text-align:left;background:transparent;border:0;border-radius:6px;' +
      'padding:10px 12px;color:' + (danger ? '#e06c75' : 'var(--ttv-fg)') + ';cursor:pointer;font:inherit;font-size:14px;';
    b.addEventListener('mouseenter', function () { b.style.background = 'var(--ttv-bg-elev2,#2d2d30)'; });
    b.addEventListener('mouseleave', function () { b.style.background = 'transparent'; });
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });
    b.addEventListener('click', onTap);
    return b;
  }
  function openTabMenu(anchor, session) {
    closeMenu();
    menu = document.createElement('div');
    menu.id = 'mcc-tabmenu';
    menu.style.cssText =
      'position:fixed;z-index:1000;min-width:190px;background:var(--ttv-bg-elev,#252526);' +
      'border:1px solid var(--ttv-border,#3a3a3a);border-radius:8px;padding:6px;box-shadow:0 6px 24px rgba(0,0,0,.45);';
    var hdr = document.createElement('div');
    hdr.textContent = session;
    hdr.style.cssText = 'padding:4px 12px 2px;color:var(--ttv-muted);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    menu.appendChild(hdr);
    // Full subtitle preview — the tab clips it, so this is where you read the
    // whole thing. Wraps (no ellipsis); tap to jump into the edit flow. Hidden
    // when the tab has no subtitle (the "Subtitle…" item still adds one).
    var subText = '';
    try { subText = (window.ttvTabsGetLabel && window.ttvTabsGetLabel(session)) || ''; } catch (e) {}
    if (subText) {
      var sub = document.createElement('button');
      sub.type = 'button'; sub.tabIndex = -1; sub.textContent = subText;
      sub.title = 'Tap to edit subtitle';
      sub.style.cssText =
        'display:block;width:100%;text-align:left;background:transparent;border:0;cursor:pointer;' +
        'padding:0 12px 8px;margin:0;font:inherit;font-size:12px;line-height:1.4;' +
        'color:var(--ttv-accent,#E8896B);white-space:normal;overflow-wrap:anywhere;';
      sub.addEventListener('mousedown', function (e) { e.preventDefault(); });
      sub.addEventListener('click', function () { closeMenu(); subtitleFlow(session); });
      menu.appendChild(sub);
    }
    menu.appendChild(menuItem('Subtitle…', function () { closeMenu(); subtitleFlow(session); }));
    menu.appendChild(menuItem('Rename…', function () { closeMenu(); renameFlow(session); }));
    menu.appendChild(menuItem('Move to project…', function () { closeMenu(); openMoveDialog(session); }));
    menu.appendChild(menuItem('Remove from recents', function () { closeMenu(); removeFromRecents(session); }));
    menu.appendChild(menuItem('Kill session', function () { closeMenu(); killFlow(session); }, true));
    document.body.appendChild(menu);
    // Position left-anchored to the button but CLAMPED to the viewport, so a
    // menu opened from a left-edge tab doesn't run off-screen (was clipping).
    var r = anchor.getBoundingClientRect();
    var mw = menu.offsetWidth || 200;
    var left = Math.min(Math.max(6, r.left), window.innerWidth - mw - 6);
    menu.style.left = Math.max(6, left) + 'px';
    if (r.top > window.innerHeight / 2) menu.style.bottom = (window.innerHeight - r.top + 6) + 'px';
    else menu.style.top = (r.bottom + 6) + 'px';
    // Close on outside click — but NOT when the click is on any ⋮ button
    // (its own click handler toggles). Using the ⋮ class instead of the
    // captured `anchor` ref fixes the "first tap to close does nothing" bug:
    // the observer re-injects ⋮ buttons, so `anchor` could be a stale node and
    // a tap on the fresh ⋮ would close-then-reopen.
    outside = function (e) {
      if (!menu) return;
      if (menu.contains(e.target)) return;
      if (e.target.closest && e.target.closest('.mcc-tabmenu-btn')) return;
      closeMenu();
    };
    setTimeout(function () { document.addEventListener('pointerdown', outside, true); }, 0);
  }

  // ---- modal (rename + kill-confirm) ----
  function openModal(opts) { // { title, body(modal), buttons:[{label,danger,onTap(close)}] }
    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:1100;background:rgba(0,0,0,.5);display:flex;align-items:flex-start;justify-content:center;padding:60px 12px;';
    var modal = document.createElement('div');
    modal.style.cssText = 'background:var(--ttv-bg-elev,#252526);border:1px solid var(--ttv-border,#3a3a3a);border-radius:10px;padding:16px;width:min(380px,92vw);box-shadow:0 8px 32px rgba(0,0,0,.5);';
    var h = document.createElement('h3'); h.textContent = opts.title; h.style.cssText = 'margin:0 0 12px;font-size:16px;color:var(--ttv-fg);';
    modal.appendChild(h);
    function close() { overlay.remove(); }
    if (opts.body) opts.body(modal, close);
    var row = document.createElement('div'); row.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:14px;';
    (opts.buttons || []).forEach(function (b) { row.appendChild(mkBtn(b.label, function () { b.onTap(close); }, b.danger)); });
    modal.appendChild(row);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    return { modal: modal, close: close };
  }

  function renameFlow(session) {
    var inp;
    openModal({
      title: 'Rename session',
      body: function (modal) {
        inp = document.createElement('input');
        inp.type = 'text'; inp.value = session; inp.autocapitalize = 'off'; inp.autocomplete = 'off'; inp.spellcheck = false;
        inp.style.cssText = 'width:100%;box-sizing:border-box;background:var(--ttv-bg,#1e1e1e);color:var(--ttv-fg);border:1px solid var(--ttv-border,#3a3a3a);border-radius:6px;padding:8px 10px;font:inherit;font-size:14px;';
        modal.appendChild(inp);
        setTimeout(function () { inp.focus(); inp.select(); }, 0);
      },
      buttons: [
        { label: 'Cancel', onTap: function (close) { close(); } },
        { label: 'Rename', onTap: function (close) {
          var to = sanitize(inp.value);
          if (!to || to === session) { close(); return; }
          close();
          apiRename(session, to).then(function () { tv.refreshPanes(); flash('Renamed to ' + to); })
            .catch(function (e) { flash('Rename failed: ' + e.message, true); });
        } },
      ],
    });
  }

  // Set / clear / AI-generate a tab's subtitle (the per-session custom tag
  // rendered under the name). Commits through ttyview-tabs' public
  // window.ttvTabsSetLabel (re-renders immediately); falls back to a
  // storage write + reload if that API isn't present. The ✨ button shows
  // only when window.ttvTagSuggest exists (mobile-cc-tabs + a Groq key).
  function subtitleFlow(session) {
    var inp, genBtn;
    var cur = '';
    try { cur = (window.ttvTabsGetLabel && window.ttvTabsGetLabel(session)) || ''; } catch (e) {}
    openModal({
      title: 'Tab subtitle',
      body: function (modal) {
        var hint = document.createElement('p');
        hint.textContent = 'A short note shown under the tab name — what this session is about. Leave empty to clear.';
        hint.style.cssText = 'margin:0 0 10px;color:var(--ttv-muted);font-size:12px;line-height:1.4;';
        modal.appendChild(hint);
        inp = document.createElement('input');
        inp.type = 'text'; inp.value = cur; inp.placeholder = 'e.g. fixing keyboard bug';
        inp.maxLength = 40;
        inp.autocapitalize = 'off'; inp.autocomplete = 'off'; inp.spellcheck = false;
        inp.style.cssText = 'width:100%;box-sizing:border-box;background:var(--ttv-bg,#1e1e1e);color:var(--ttv-fg);border:1px solid var(--ttv-border,#3a3a3a);border-radius:6px;padding:8px 10px;font:inherit;font-size:14px;';
        modal.appendChild(inp);
        if (typeof window.ttvTagSuggest === 'function') {
          var row = document.createElement('div');
          row.style.cssText = 'margin-top:10px;';
          genBtn = mkBtn('✨ Generate with AI', function () {
            genBtn.disabled = true;
            var old = genBtn.textContent; genBtn.textContent = '✨ Generating…';
            Promise.resolve().then(function () { return window.ttvTagSuggest(session); })
              .then(function (s) { inp.value = s; })
              .catch(function (e) { flash('AI failed: ' + e.message, true); })
              .then(function () { genBtn.disabled = false; genBtn.textContent = old; });
          });
          row.appendChild(genBtn);
          modal.appendChild(row);
        }
        setTimeout(function () { inp.focus(); inp.select(); }, 0);
      },
      buttons: [
        { label: 'Cancel', onTap: function (close) { close(); } },
        { label: 'Save', onTap: function (close) {
          var val = (inp.value || '').trim();
          close();
          if (typeof window.ttvTabsSetLabel === 'function') {
            window.ttvTabsSetLabel(session, val);
            flash(val ? 'Subtitle set' : 'Subtitle cleared');
          } else {
            try {
              var s = tv.storage('ttyview-tabs'); var l = s.get('labels') || {};
              if (val) l[session] = val; else delete l[session];
              s.set('labels', l);
            } catch (e) {}
            flash('Subtitle saved — reloading…');
            setTimeout(function () { try { location.reload(); } catch (e) {} }, 400);
          }
        } },
      ],
    });
  }

  function killFlow(session) {
    openModal({
      title: 'Kill session?',
      body: function (modal) {
        var p = document.createElement('p');
        p.innerHTML = 'This ends <b>' + session.replace(/[&<>]/g, '') + '</b> and everything running in it (Claude Code, shells). This can’t be undone.';
        p.style.cssText = 'margin:0;color:var(--ttv-muted);font-size:13px;line-height:1.4;';
        modal.appendChild(p);
      },
      buttons: [
        { label: 'Cancel', onTap: function (close) { close(); } },
        { label: 'Kill', danger: true, onTap: function (close) {
          close();
          var active = (tv.getActivePane && tv.getActivePane()) || null;
          apiKill(session).then(function () {
            return tv.refreshPanes();
          }).then(function () {
            // if we killed the pane we were viewing, switch to another
            if (active && active.session === session) {
              var others = (tv.listPanes() || []).filter(function (x) { return x.session !== session; });
              if (others.length) tv.selectPane(others[0].id);
            }
            flash('Killed ' + session);
          }).catch(function (e) { flash('Kill failed: ' + e.message, true); });
        } },
      ],
    });
  }

  function openMoveDialog(session) {
    var cur = deriveGroup(session);
    var groups = getGroups().filter(function (g) { return g !== cur; });
    var inp;
    var dlg = openModal({
      title: 'Move "' + session + '" to project',
      body: function (modal, close) {
        var hint = document.createElement('p');
        hint.textContent = 'Pick a project (the tab is renamed to <project>-claude<N> so it groups there), or make a new one.';
        hint.style.cssText = 'margin:0 0 12px;color:var(--ttv-muted);font-size:12px;line-height:1.4;';
        modal.appendChild(hint);
        if (groups.length) {
          var wrap = document.createElement('div');
          wrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;';
          groups.forEach(function (g) {
            var chip = document.createElement('button');
            chip.type = 'button'; chip.tabIndex = -1; chip.textContent = g;
            chip.style.cssText = 'border:1px solid var(--ttv-border,#3a3a3a);border-radius:999px;background:transparent;color:var(--ttv-fg);font-size:13px;padding:5px 12px;cursor:pointer;';
            chip.addEventListener('mousedown', function (e) { e.preventDefault(); });
            chip.addEventListener('click', function () { close(); moveToProject(session, g); });
            wrap.appendChild(chip);
          });
          modal.appendChild(wrap);
        }
        var lbl = document.createElement('label');
        lbl.textContent = 'New project';
        lbl.style.cssText = 'display:block;font-size:12px;color:var(--ttv-muted);margin-bottom:4px;';
        modal.appendChild(lbl);
        inp = document.createElement('input');
        inp.type = 'text'; inp.placeholder = 'project name'; inp.autocapitalize = 'off'; inp.autocomplete = 'off'; inp.spellcheck = false;
        inp.style.cssText = 'width:100%;box-sizing:border-box;background:var(--ttv-bg,#1e1e1e);color:var(--ttv-fg);border:1px solid var(--ttv-border,#3a3a3a);border-radius:6px;padding:8px 10px;font:inherit;font-size:14px;';
        modal.appendChild(inp);
      },
      buttons: [
        { label: 'Cancel', onTap: function (close) { close(); } },
        { label: 'Create & move', onTap: function (close) {
          var name = sanitize(inp.value);
          if (!name) { close(); return; }
          close();
          moveToProject(session, name);
        } },
      ],
    });
  }

  // ---- inject ⋮ into each tab ----
  function injectButtons() {
    var rail = document.querySelector('.ttvtab-rail');
    var scope = rail ? (rail.closest('[data-slot]') || rail.parentNode || document) : document;
    var tabs = scope.querySelectorAll('.ttvtab');
    for (var i = 0; i < tabs.length; i++) {
      var t = tabs[i];
      if (t.classList.contains('ttvtab-railbtn') || t.classList.contains('ttvtab-add') ||
          t.id === 'mcc-newtab-railbtn' || t.classList.contains('missing')) continue;
      if (t.querySelector('.mcc-tabmenu-btn')) continue;
      // ttyview-tabs sets a CLEAN session on dataset.session; t.title is
      // polluted with the long-press hint ("mcc17 (press & hold to mark
      // todo/done)"), which broke subtitle save (wrong key) + AI (no pane
      // match). Prefer dataset.session; strip a trailing " (...)" hint as
      // a fallback for older renders.
      var session = t.dataset.session || (t.title || '').replace(/\s+\(.*\)\s*$/, '');
      if (!session) continue;
      if (getComputedStyle(t).position === 'static') t.style.position = 'relative';
      var dots = document.createElement('button');
      dots.type = 'button'; dots.tabIndex = -1; dots.className = 'mcc-tabmenu-btn';
      dots.textContent = '⋮';
      dots.setAttribute('data-session', session);
      dots.style.cssText =
        'position:absolute;top:0;right:0;width:22px;height:22px;line-height:20px;text-align:center;' +
        'background:transparent;border:0;color:var(--ttv-muted,#9aa);font-size:16px;cursor:pointer;' +
        'border-radius:6px;z-index:2;opacity:0.75;';
      (function (sessName, el) {
        function stop(e) { e.stopPropagation(); }
        el.addEventListener('pointerdown', stop, true);
        el.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); }, true);
        el.addEventListener('touchstart', stop, true);
        el.addEventListener('click', function (e) {
          e.preventDefault(); e.stopPropagation();
          if (menu) closeMenu(); else openTabMenu(el, sessName);
        });
      })(session, dots);
      t.appendChild(dots);
    }
  }

  // ---- non-project (ungrouped) pinned tabs → bottom -----------------
  // ttyview-tabs renders ungrouped pins as a headerless row ABOVE the project
  // groups. Move them BELOW the groups, under a thin labelless divider, so the
  // projects lead and loose one-off tabs (mcc-build, etc.) collect at the end.
  // Pure DOM, mcc-only (panel/tmux-web never load this plugin). Idempotent: it
  // only acts on rows that are still ABOVE the first group, so after a move the
  // next observer tick is a no-op until ttyview-tabs re-renders (which resets
  // content, and we re-apply). The divider has class mcc-ungrouped-sep.
  function reorderUngrouped() {
    var group = document.querySelector('.ttvtab-group');
    if (!group || !group.parentNode) return;          // need ≥1 project group
    var content = group.parentNode;
    var old = content.querySelector(':scope > .mcc-ungrouped-sep');
    if (old) old.remove();
    // Leading direct-child .ttvtab-row(s) before the first group = ungrouped.
    var rows = [], n = content.firstChild;
    while (n && n !== group) {
      var next = n.nextSibling;
      if (n.nodeType === 1 && n.classList && n.classList.contains('ttvtab-row')) rows.push(n);
      n = next;
    }
    if (!rows.length) return;                          // already at bottom
    var sep = document.createElement('div');
    sep.className = 'mcc-ungrouped-sep';
    sep.style.cssText = 'height:0;border-top:1px solid var(--ttv-border,#3a3a3a);opacity:0.55;margin:8px 6px 4px;';
    content.appendChild(sep);
    rows.forEach(function (r) { content.appendChild(r); });
  }

  function paint() { injectButtons(); reorderUngrouped(); }

  var pending = false;
  function schedule() {
    if (pending) return; pending = true;
    var raf = window.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
    raf(function () { pending = false; paint(); });
  }
  (function boot() {
    var tries = 0, attached = false;
    function attach() {
      var rail = document.querySelector('.ttvtab-rail');
      if (!rail) return false;
      paint();
      var host = rail.closest('[data-slot]') || rail.parentNode || document.body;
      try { new MutationObserver(schedule).observe(host, { childList: true, subtree: true }); attached = true; } catch (e) {}
      return true;
    }
    var iv = setInterval(function () { if (attach() || ++tries > 60) clearInterval(iv); }, 250);
    attach();
    setInterval(function () { if (!attached) attach(); else paint(); }, 2000);
  })();
})();
