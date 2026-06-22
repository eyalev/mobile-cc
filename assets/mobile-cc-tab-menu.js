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
  // Move = rename so the name groups under <project> (grouping is name-based).
  function moveToProject(session, project) {
    var to = numberedName(project + '-claude');
    apiRename(session, to)
      .then(function () { return tv.refreshPanes(); })
      .then(function () {
        var p = (tv.listPanes() || []).find(function (x) { return x.session === to; });
        if (p) { try { tv.selectPane(p.id); } catch (e) {} }
        flash('Moved to ' + project + ' (' + to + ')');
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
    hdr.style.cssText = 'padding:4px 12px 8px;color:var(--ttv-muted);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    menu.appendChild(hdr);
    menu.appendChild(menuItem('Rename…', function () { closeMenu(); renameFlow(session); }));
    menu.appendChild(menuItem('Move to project…', function () { closeMenu(); openMoveDialog(session); }));
    var inRecents = (function () {
      try { var r = tv.storage('ttyview-tabs').get('recents'); return Array.isArray(r) && r.indexOf(session) !== -1; }
      catch (e) { return false; }
    })();
    if (inRecents) menu.appendChild(menuItem('Remove from recents', function () { closeMenu(); removeFromRecents(session); }));
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
    outside = function (e) { if (menu && !menu.contains(e.target) && e.target !== anchor) closeMenu(); };
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
      var session = t.title;
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

  var pending = false;
  function schedule() {
    if (pending) return; pending = true;
    var raf = window.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
    raf(function () { pending = false; injectButtons(); });
  }
  (function boot() {
    var tries = 0, attached = false;
    function attach() {
      var rail = document.querySelector('.ttvtab-rail');
      if (!rail) return false;
      injectButtons();
      var host = rail.closest('[data-slot]') || rail.parentNode || document.body;
      try { new MutationObserver(schedule).observe(host, { childList: true, subtree: true }); attached = true; } catch (e) {}
      return true;
    }
    var iv = setInterval(function () { if (attach() || ++tries > 60) clearInterval(iv); }, 250);
    attach();
    setInterval(function () { if (!attached) attach(); else injectButtons(); }, 2000);
  })();
})();
