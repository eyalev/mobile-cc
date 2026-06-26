// mobile-cc-tab-switch — keyboard tab switching for desktop/laptop.
//
// On a physical keyboard you want to flip between session tabs without
// reaching for the mouse. This plugin binds a chord (default Ctrl+Alt+→/←)
// that cycles the active pane, with two ordering modes and a few selectable
// keybinding presets (Settings → Tab Switching).
//
// Why not just Ctrl+Tab? In a NORMAL browser tab Chrome RESERVES Ctrl+Tab
// (and Ctrl+1..9, Ctrl+PageUp/Down) to switch BROWSER tabs — the page gets
// the keydown but preventDefault() is ignored, so the chord never fires.
// Those only work in the installed PWA / standalone window. mobile-cc's
// desktop use is a regular browser tab, so the default is Ctrl+Alt+Arrow,
// which Chrome leaves alone. Ctrl+Tab stays available as an opt-in preset
// for anyone running the standalone PWA.
//
// Two ordering modes:
//   positional — walk the pinned tab-bar order (then any unpinned live
//                panes). "Next tab to the right." Predictable, stateless.
//   mru        — browser/Alt-Tab style: hold the modifier, tap to walk the
//                recency stack, release to commit the landed tab to front.
//
// Touch-only devices (phones) get nothing here — no physical keyboard.
// Binds capture-phase on window so it runs BEFORE mobile-cc-kbd-passthrough's
// #grid-host handler and works regardless of where focus sits.
(function () {
  var tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) return;
  if (window.__mccTabSwitch) return;
  window.__mccTabSwitch = true;

  // Fine pointer = mouse/trackpad present (a touchscreen laptop has both and
  // still qualifies; a phone is coarse-only and skips out).
  var fine = window.matchMedia && window.matchMedia('(any-pointer: fine)').matches;
  if (!fine) return;

  var SELF = tv.storage('mobile-cc-tab-switch');
  var DEFAULT_BINDING = 'ctrl-alt-arrow';
  var DEFAULT_ORDER = 'positional';

  // dir(): +1 = next (right/down), -1 = prev (left/up).
  // Letter keys use e.code (Alt+letter can yield odd e.key chars on some OSes).
  var PRESETS = {
    'ctrl-alt-arrow': {
      label: 'Ctrl+Alt+→ / ←',
      hint: 'Free in a normal browser tab. Recommended for desktop.',
      match: function (e) { return e.ctrlKey && e.altKey && !e.metaKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft'); },
      dir: function (e) { return e.key === 'ArrowRight' ? 1 : -1; },
    },
    'ctrl-backtick': {
      label: 'Ctrl+` / Ctrl+Shift+`',
      hint: 'Editor-style cycle. Free in a normal browser tab.',
      match: function (e) { return e.ctrlKey && !e.altKey && !e.metaKey && (e.code === 'Backquote' || e.key === '`' || e.key === '~'); },
      dir: function (e) { return e.shiftKey ? -1 : 1; },
    },
    'alt-arrow': {
      label: 'Alt+→ / ←',
      hint: 'Overrides browser back/forward on these keys.',
      match: function (e) { return e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft'); },
      dir: function (e) { return e.key === 'ArrowRight' ? 1 : -1; },
    },
    'alt-jk': {
      label: 'Alt+K / Alt+J',
      hint: 'Vim-style (J next, K prev). Free in a normal browser tab.',
      match: function (e) { return e.altKey && !e.ctrlKey && !e.metaKey && (e.code === 'KeyJ' || e.code === 'KeyK'); },
      dir: function (e) { return e.code === 'KeyJ' ? 1 : -1; },
    },
    'ctrl-tab': {
      label: 'Ctrl+Tab / Ctrl+Shift+Tab',
      hint: 'Only works in the installed PWA / standalone window — reserved by Chrome in a normal tab.',
      match: function (e) { return e.key === 'Tab' && e.ctrlKey && !e.altKey && !e.metaKey; },
      dir: function (e) { return e.shiftKey ? -1 : 1; },
    },
  };
  var PRESET_ORDER = ['ctrl-alt-arrow', 'ctrl-backtick', 'alt-arrow', 'alt-jk', 'ctrl-tab'];

  function cfg() {
    return {
      enabled: SELF.get('enabled') !== false,            // default ON
      order: SELF.get('order') === 'mru' ? 'mru' : DEFAULT_ORDER,
      binding: PRESETS[SELF.get('binding')] ? SELF.get('binding') : DEFAULT_BINDING,
    };
  }

  // ---- ordering helpers ----------------------------------------------------

  // Live panes, one per session, keyed for quick lookup.
  function liveBySession() {
    var panes = (tv.listPanes && tv.listPanes()) || [];
    var by = {};
    panes.forEach(function (p) { if (p && p.session && !(p.session in by)) by[p.session] = p; });
    return { panes: panes, by: by };
  }

  // Which tab set the bar is currently SHOWING. ttyview-tabs has three view
  // modes (rail icons): 'pinned' (default), 'all', 'recent'. The positional
  // cycle follows whichever is on screen — so when you're in the 🕘 recent
  // view, switching walks the recent tabs, not the pinned ones.
  function tabsMode() {
    try {
      var s = tv.storage('ttyview-tabs').get('settings');
      var m = s && s.mode;
      return (m === 'all' || m === 'recent') ? m : 'pinned';
    } catch (_) { return 'pinned'; }
  }

  // Pinned order first (from the ttyview-tabs plugin), then any unpinned live
  // panes — what 'pinned' view shows.
  function pinnedList(lv) {
    var out = [], seen = {};
    try {
      var pins = tv.storage('ttyview-tabs').get('pins');
      if (Array.isArray(pins)) {
        pins.forEach(function (pin) {
          var s = pin && pin.session;
          if (s && lv.by[s] && !seen[s]) { out.push(lv.by[s]); seen[s] = true; }
        });
      }
    } catch (_) {}
    lv.panes.forEach(function (p) {
      if (p && p.session && !seen[p.session]) { out.push(p); seen[p.session] = true; }
    });
    return out;
  }

  // Replicates ttyview-tabs.liveRecents(panes, false) — the order the 🕘
  // recent view renders: stored `recents` (MRU, live only) first, then every
  // never-visited live session alphabetically. Reads the SAME `recents`
  // storage the tab bar does, so the cycle matches the view exactly.
  function recentList(lv) {
    var out = [], seen = {};
    try {
      var rec = tv.storage('ttyview-tabs').get('recents');
      if (Array.isArray(rec)) rec.forEach(function (s) {
        if (s && lv.by[s] && !seen[s]) { out.push(lv.by[s]); seen[s] = true; }
      });
    } catch (_) {}
    var rest = [];
    lv.panes.forEach(function (p) {
      if (p && p.session && !seen[p.session]) { seen[p.session] = true; rest.push(p); }
    });
    rest.sort(function (a, b) { return String(a.session).localeCompare(String(b.session)); });
    return out.concat(rest);
  }

  // Every live pane, listPanes order — what 'all' view shows.
  function allList(lv) {
    var out = [], seen = {};
    lv.panes.forEach(function (p) {
      if (p && p.session && !seen[p.session]) { out.push(p); seen[p.session] = true; }
    });
    return out;
  }

  // The cycle list for positional mode = the currently-shown tab set/order.
  function viewList() {
    var lv = liveBySession();
    var m = tabsMode();
    if (m === 'recent') return recentList(lv);
    if (m === 'all') return allList(lv);
    return pinnedList(lv);
  }

  function switchPositional(dir) {
    var list = viewList();
    if (list.length < 2) return;
    var cur = tv.getActivePane && tv.getActivePane();
    var i = -1;
    if (cur) i = list.findIndex(function (p) { return p.id === cur.id || p.session === cur.session; });
    if (i < 0) i = 0;
    var n = (i + dir + list.length) % list.length;
    try { tv.selectPane(list[n].id); } catch (_) {}
  }

  // ---- MRU (recency) -------------------------------------------------------

  var mru = [];                 // sessions, most-recent first
  var cycling = false;          // mid-walk (modifier held)
  var cycleList = null;         // snapshot of panes taken at walk start
  var cycleIdx = 0;

  function noteMru(session) {
    if (!session) return;
    mru = mru.filter(function (s) { return s !== session; });
    mru.unshift(session);
  }

  // MRU order restricted to currently-live panes, plus any live pane not yet
  // seen (newly created) appended.
  function mruList() {
    var lv = liveBySession();
    var by = lv.by, out = [];
    mru.forEach(function (s) { if (by[s]) { out.push(by[s]); delete by[s]; } });
    lv.panes.forEach(function (p) { if (p && p.session && by[p.session]) { out.push(p); delete by[p.session]; } });
    return out;
  }

  function switchMru(dir) {
    if (!cycling) {
      cycleList = mruList();
      if (cycleList.length < 2) { cycleList = null; return; }
      cycleIdx = 0;             // 0 = current (front of MRU)
      cycling = true;
    }
    cycleIdx = (cycleIdx + dir + cycleList.length) % cycleList.length;
    try { tv.selectPane(cycleList[cycleIdx].id); } catch (_) {}
  }

  function commitMru() {
    if (!cycling) return;
    var landed = cycleList && cycleList[cycleIdx];
    cycling = false; cycleList = null; cycleIdx = 0;
    if (landed) noteMru(landed.session);
  }

  // Seed + track recency. Don't reorder mid-walk (would corrupt the snapshot).
  try {
    var seed = tv.getActivePane && tv.getActivePane();
    if (seed) noteMru(seed.session);
  } catch (_) {}
  if (tv.on) {
    tv.on('pane-changed', function (e) {
      if (cycling) return;
      var p = ((tv.listPanes && tv.listPanes()) || []).find(function (x) { return x.id === e.to; });
      if (p) noteMru(p.session);
    });
  }

  // ---- key handling --------------------------------------------------------

  window.addEventListener('keydown', function (e) {
    if (e.repeat) return;                  // ignore auto-repeat (no key-spam cycling)
    var c = cfg();
    if (!c.enabled) return;
    var preset = PRESETS[c.binding];
    if (!preset.match(e)) return;
    e.preventDefault();
    e.stopPropagation();
    var dir = preset.dir(e);
    if (c.order === 'mru') switchMru(dir);
    else switchPositional(dir);
  }, true);

  // Releasing the held modifier commits the MRU walk (Shift excluded — it's
  // toggled between presses for the "prev" direction).
  window.addEventListener('keyup', function (e) {
    if (!cycling) return;
    if (e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') commitMru();
  }, true);

  // ---- settings tab --------------------------------------------------------

  if (tv.contributes && tv.contributes.settingsTab) {
    tv.contributes.settingsTab({
      id: 'mobile-cc-tab-switch',
      title: 'Tab Switching',
      render: function (container) {
        container.innerHTML = '';

        var intro = document.createElement('p');
        intro.style.cssText = 'color:var(--ttv-muted);font-size:12px;margin:0 0 16px;';
        intro.textContent = 'Switch session tabs from a physical keyboard (desktop/laptop). ' +
          'Pick a key chord and how the cycle is ordered.';
        container.appendChild(intro);

        // Enable toggle.
        var eRow = document.createElement('label');
        eRow.style.cssText = 'display:flex;align-items:center;gap:10px;color:var(--ttv-fg);font-size:14px;margin-bottom:18px;cursor:pointer;';
        var chk = document.createElement('input');
        chk.type = 'checkbox'; chk.checked = cfg().enabled;
        chk.addEventListener('change', function () { SELF.set('enabled', chk.checked); });
        eRow.appendChild(chk);
        eRow.appendChild(document.createTextNode('Enable keyboard tab switching'));
        container.appendChild(eRow);

        // Generic segmented-control builder.
        function segmented(labelText, opts, getCur, onPick, hintEl) {
          var wrap = document.createElement('div');
          wrap.style.cssText = 'margin-bottom:18px;';
          var lbl = document.createElement('div');
          lbl.style.cssText = 'font-size:13px;color:var(--ttv-fg);margin-bottom:6px;';
          lbl.textContent = labelText;
          wrap.appendChild(lbl);
          var seg = document.createElement('div');
          seg.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
          function paint() {
            var cur = getCur();
            Array.prototype.forEach.call(seg.children, function (b) {
              var on = b.dataset.val === cur;
              b.style.background = on ? 'var(--ttv-accent,#569cd6)' : 'var(--ttv-bg-elev2,#2d2d30)';
              b.style.color = on ? '#1e1e1e' : 'var(--ttv-fg)';
              b.style.borderColor = on ? 'var(--ttv-accent,#569cd6)' : 'var(--ttv-border,#3a3a3a)';
            });
            if (hintEl) {
              var o = opts.filter(function (x) { return x.val === cur; })[0];
              hintEl.textContent = o && o.hint ? o.hint : '';
            }
          }
          opts.forEach(function (o) {
            var b = document.createElement('button');
            b.type = 'button'; b.tabIndex = -1; b.dataset.val = o.val; b.textContent = o.label;
            b.style.cssText = 'flex:1;min-width:120px;height:38px;font-size:13px;border:1px solid var(--ttv-border,#3a3a3a);border-radius:8px;cursor:pointer;';
            b.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
            b.addEventListener('click', function () { onPick(o.val); paint(); });
            seg.appendChild(b);
          });
          wrap.appendChild(seg);
          paint();
          return wrap;
        }

        // Order.
        var orderHint = document.createElement('div');
        orderHint.style.cssText = 'color:var(--ttv-muted);font-size:11px;margin:-12px 0 18px;';
        container.appendChild(segmented(
          'Cycle order',
          [
            { val: 'positional', label: 'Positional', hint: 'Walk the tabs currently shown in the bar, in order — pinned, all, or recent view.' },
            { val: 'mru', label: 'Recent (MRU)', hint: 'Hold the modifier and tap to walk the recently-used stack; release to land — like Alt-Tab.' },
          ],
          function () { return cfg().order; },
          function (v) { SELF.set('order', v); },
          orderHint
        ));
        container.appendChild(orderHint);

        // Keybinding.
        var bindHint = document.createElement('div');
        bindHint.style.cssText = 'color:var(--ttv-muted);font-size:11px;margin:-12px 0 0;';
        container.appendChild(segmented(
          'Keybinding',
          PRESET_ORDER.map(function (id) { return { val: id, label: PRESETS[id].label, hint: PRESETS[id].hint }; }),
          function () { return cfg().binding; },
          function (v) { SELF.set('binding', v); },
          bindHint
        ));
        container.appendChild(bindHint);
      },
    });
  }
})();
