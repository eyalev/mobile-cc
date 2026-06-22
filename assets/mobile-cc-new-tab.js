// mobile-cc-new-tab — a ＋ button in the header that opens a small menu to
// create a new session three ways:
//   • Blank tab            — a bare shell
//   • Claude tab           — a shell with Claude Code already running
//   • Claude in project…   — Claude Code in a chosen project folder (grouped)
//
// Coordination-safe: touches NO ttyview-core. Sessions are created via the
// existing POST /api/sessions endpoint; Claude is launched by sending
// `<cmd>\r` to the new pane with tv.sendInput (the same path Quick Keys /
// command chips use). Running Claude *inside* the shell (rather than as the
// session's root command) means the tab survives Claude exiting.
//
// Naming → grouping (ttyview-tabs derives a group from `<name><digits>`):
//   • Blank  → `tab`  (ungrouped; collisions become tab-b, tab-c, …)
//   • Claude → `cc`   (ungrouped; cc-b, cc-c, …)
//   • Project→ `<folder>-claude<N>`  (groups under the folder name)
//
// The launch command defaults to `claude` and is configurable in
// Settings → New Tab (set it to `ccpc` etc.).
(function () {
  var tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) return;

  var STORE = tv.storage('mobile-cc-new-tab');
  var DEFAULT_CMD = 'claude';
  function launchCmd() {
    var c = STORE.get('command');
    return (typeof c === 'string' && c.trim()) ? c.trim() : DEFAULT_CMD;
  }
  function recents() { var r = STORE.get('recents'); return Array.isArray(r) ? r : []; }
  function noteRecent(dir) {
    var r = recents().filter(function (d) { return d !== dir; });
    r.unshift(dir);
    STORE.set('recents', r.slice(0, 8));
  }

  // ---- api ----
  async function apiCreate(name, cwd) {
    var body = cwd ? { name: name, cwd: cwd } : { name: name };
    var res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      var j = await res.json().catch(function () { return {}; });
      throw new Error(j.error || ('HTTP ' + res.status));
    }
    return res.json();
  }

  // ---- naming ----
  function existingNames() {
    var s = new Set();
    try { tv.listPanes().forEach(function (p) { s.add(p.session); }); } catch (e) {}
    return s;
  }
  function sanitize(s) {
    return (s || '').trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
  }
  function basename(p) {
    return (p || '').replace(/\/+$/, '').split('/').pop() || 'project';
  }
  // Ungrouped + readable: base, then base-b, base-c, … (no trailing digits,
  // so ttyview-tabs leaves them out of project groups).
  function ungroupedName(base) {
    var names = existingNames();
    if (!names.has(base)) return base;
    for (var i = 98; i <= 122; i++) { // 'b'..'z'
      var n = base + '-' + String.fromCharCode(i);
      if (!names.has(n)) return n;
    }
    return base + '-' + Date.now();
  }
  // Grouped: base + N (1, 2, …) so `<folder>-claude1` groups under <folder>.
  function numberedName(base) {
    var names = existingNames();
    for (var i = 1; i < 999; i++) { if (!names.has(base + i)) return base + i; }
    return base + Date.now();
  }

  async function waitForPane(session, ms) {
    var deadline = Date.now() + (ms || 5000);
    while (Date.now() < deadline) {
      try { await tv.refreshPanes(); } catch (e) {}
      var p = (tv.listPanes() || []).find(function (x) { return x.session === session; });
      if (p) return p;
      await new Promise(function (r) { setTimeout(r, 250); });
    }
    return (tv.listPanes() || []).find(function (x) { return x.session === session; }) || null;
  }

  // Create the session, switch to it, and (optionally) launch Claude in it.
  async function createTab(opts) { // { name, cwd?, runClaude }
    try {
      await apiCreate(opts.name, opts.cwd);
    } catch (e) {
      flash('Couldn’t create session: ' + e.message);
      return;
    }
    var pane = await waitForPane(opts.name, 6000);
    if (!pane) { try { await tv.refreshPanes(); } catch (e) {} return; }
    try { tv.selectPane(pane.id); } catch (e) {}
    if (opts.runClaude) {
      // Let the shell come up, then launch. The pane survives if Claude exits.
      setTimeout(function () {
        try { tv.sendInput(pane.id, launchCmd() + '\r'); } catch (e) {}
      }, 500);
    }
  }

  // ---- tiny transient toast (for rare create errors) ----
  function flash(msg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText =
      'position:fixed;left:50%;bottom:80px;transform:translateX(-50%);z-index:1200;' +
      'background:#7a2230;color:#fff;border:1px solid #a83b4a;border-radius:8px;' +
      'padding:8px 12px;font-size:13px;max-width:80vw;box-shadow:0 6px 24px rgba(0,0,0,.5);';
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 4000);
  }

  // ---- shared bits ----
  function mkBtn(label, title, onTap) {
    var b = document.createElement('button');
    b.type = 'button';
    b.tabIndex = -1;
    b.textContent = label;
    if (title) b.title = title;
    b.style.cssText =
      'min-width:34px;height:32px;padding:0 10px;border:1px solid var(--ttv-border,#3a3a3a);' +
      'border-radius:6px;background:transparent;color:var(--ttv-fg);font-size:14px;' +
      'cursor:pointer;font-family:inherit;line-height:1;';
    b.addEventListener('click', onTap);
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });
    return b;
  }

  // ---- the ＋ menu ----
  var menu = null, outside = null;
  function closeMenu() {
    if (menu) { menu.remove(); menu = null; }
    if (outside) { document.removeEventListener('pointerdown', outside, true); outside = null; }
  }
  function menuItem(title, sub, onTap) {
    var b = document.createElement('button');
    b.type = 'button';
    b.tabIndex = -1;
    b.style.cssText =
      'display:block;width:100%;text-align:left;background:transparent;border:0;' +
      'border-radius:6px;padding:9px 10px;color:var(--ttv-fg);cursor:pointer;font:inherit;';
    var t = document.createElement('div');
    t.textContent = title;
    t.style.cssText = 'font-size:14px;';
    var s = document.createElement('div');
    s.textContent = sub;
    s.style.cssText = 'font-size:11px;color:var(--ttv-muted);margin-top:2px;';
    b.appendChild(t); b.appendChild(s);
    b.addEventListener('mouseenter', function () { b.style.background = 'var(--ttv-bg-elev2,#2d2d30)'; });
    b.addEventListener('mouseleave', function () { b.style.background = 'transparent'; });
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });
    b.addEventListener('click', onTap);
    return b;
  }
  function openMenu(anchor) {
    menu = document.createElement('div');
    menu.id = 'mcc-newtab-menu';
    menu.style.cssText =
      'position:fixed;z-index:1000;min-width:230px;' +
      'background:var(--ttv-bg-elev,#252526);border:1px solid var(--ttv-border,#3a3a3a);' +
      'border-radius:8px;padding:6px;box-shadow:0 6px 24px rgba(0,0,0,.45);';
    menu.appendChild(menuItem('Blank tab', 'A bare shell', function () {
      closeMenu(); createTab({ name: ungroupedName('tab'), runClaude: false });
    }));
    menu.appendChild(menuItem('Claude tab', 'Shell with Claude Code running', function () {
      closeMenu(); createTab({ name: ungroupedName('cc'), runClaude: true });
    }));
    menu.appendChild(menuItem('Claude in project…', 'Pick a folder — grouped by project', function () {
      closeMenu(); openProjectDialog();
    }));
    document.body.appendChild(menu);
    // Position relative to the anchor (the rail ＋ sits low on screen, so the
    // menu opens UPWARD and right-aligned to the button). Falls back to
    // top-right if the anchor has no geometry.
    var r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
    if (r && r.width) {
      // Left-anchored to the button but clamped to the viewport so it never
      // runs off either edge.
      var mw = menu.offsetWidth || 230;
      var left = Math.min(Math.max(6, r.left), window.innerWidth - mw - 6);
      menu.style.left = Math.max(6, left) + 'px';
      if (r.top > window.innerHeight / 2) {
        menu.style.bottom = (window.innerHeight - r.top + 6) + 'px'; // open upward
      } else {
        menu.style.top = (r.bottom + 6) + 'px';
      }
    } else {
      menu.style.right = '8px'; menu.style.top = '48px';
    }
    outside = function (e) { if (menu && !menu.contains(e.target) && e.target !== anchor) closeMenu(); };
    setTimeout(function () { document.addEventListener('pointerdown', outside, true); }, 0);
  }

  // ---- "Claude in project" dialog ----
  function openProjectDialog() {
    var overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:1100;background:rgba(0,0,0,.5);' +
      'display:flex;align-items:flex-start;justify-content:center;padding:48px 12px;';
    var modal = document.createElement('div');
    modal.style.cssText =
      'background:var(--ttv-bg-elev,#252526);border:1px solid var(--ttv-border,#3a3a3a);' +
      'border-radius:10px;padding:16px;width:min(420px,92vw);box-shadow:0 8px 32px rgba(0,0,0,.5);';
    var h = document.createElement('h3');
    h.textContent = 'Claude in project';
    h.style.cssText = 'margin:0 0 12px;font-size:16px;color:var(--ttv-fg);';
    modal.appendChild(h);

    function field(labelText, placeholder) {
      var wrap = document.createElement('div');
      wrap.style.cssText = 'margin-bottom:12px;';
      var lbl = document.createElement('label');
      lbl.textContent = labelText;
      lbl.style.cssText = 'display:block;font-size:12px;color:var(--ttv-muted);margin-bottom:4px;';
      var inp = document.createElement('input');
      inp.type = 'text';
      inp.placeholder = placeholder || '';
      inp.autocapitalize = 'off'; inp.autocomplete = 'off'; inp.spellcheck = false;
      inp.style.cssText =
        'width:100%;box-sizing:border-box;background:var(--ttv-bg,#1e1e1e);color:var(--ttv-fg);' +
        'border:1px solid var(--ttv-border,#3a3a3a);border-radius:6px;padding:8px 10px;font:inherit;font-size:14px;';
      wrap.appendChild(lbl); wrap.appendChild(inp);
      modal.appendChild(wrap);
      return inp;
    }

    var folderInp = field('Project folder (absolute path)', '/home/you/projects/my-app');
    // recents
    var rec = recents();
    if (rec.length) {
      var recWrap = document.createElement('div');
      recWrap.style.cssText = 'margin:-6px 0 12px;display:flex;flex-wrap:wrap;gap:6px;';
      rec.forEach(function (d) {
        var chip = document.createElement('button');
        chip.type = 'button'; chip.tabIndex = -1;
        chip.textContent = basename(d);
        chip.title = d;
        chip.style.cssText =
          'border:1px solid var(--ttv-border,#3a3a3a);border-radius:999px;background:transparent;' +
          'color:var(--ttv-muted);font-size:12px;padding:3px 10px;cursor:pointer;';
        chip.addEventListener('mousedown', function (e) { e.preventDefault(); });
        chip.addEventListener('click', function () { folderInp.value = d; });
        recWrap.appendChild(chip);
      });
      modal.appendChild(recWrap);
    }
    var nameInp = field('Session name (optional)', 'defaults to <folder>-claude1');

    var err = document.createElement('div');
    err.style.cssText = 'color:#e06c75;font-size:12px;min-height:16px;margin-bottom:8px;';
    modal.appendChild(err);

    var row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';
    function close() { overlay.remove(); }
    var cancel = mkBtn('Cancel', '', close);
    var create = mkBtn('Create', '', function () {
      var cwd = folderInp.value.trim();
      if (!cwd || cwd[0] !== '/') { err.textContent = 'Enter an absolute path (starts with /).'; return; }
      var name = nameInp.value.trim()
        ? sanitize(nameInp.value)
        : numberedName(sanitize(basename(cwd)) + '-claude');
      noteRecent(cwd);
      close();
      createTab({ name: name, cwd: cwd, runClaude: true });
    });
    create.style.background = 'var(--ttv-accent,#569cd6)';
    create.style.color = '#fff';
    create.style.borderColor = 'transparent';
    row.appendChild(cancel); row.appendChild(create);
    modal.appendChild(row);

    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    setTimeout(function () { folderInp.focus(); }, 0);
  }

  // ---- ＋ button in the tab rail ----
  // The rail (.ttvtab-rail, the ▦/🕘/📌/✎ strip beside the tabs) is owned by
  // ttyview-tabs and rebuilt on every render, so we DOM-inject our ＋ and
  // re-inject after each rebuild (MutationObserver + a slow interval backstop)
  // — coordination-safe, no edits to the tabs plugin. This puts "new tab"
  // right where you manage tabs, instead of a tiny icon in the top bar.
  var PLUS_SVG =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" ' +
    'stroke-width="2.4" stroke-linecap="round" aria-hidden="true">' +
    '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';

  function injectRailButton() {
    var rail = document.querySelector('.ttvtab-rail');
    if (!rail) return false;
    if (rail.querySelector('#mcc-newtab-railbtn')) return true; // already there
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'mcc-newtab-railbtn';
    btn.className = 'ttvtab ttvtab-railbtn'; // inherit native rail-button styling
    btn.title = 'New tab';
    btn.setAttribute('aria-label', 'New tab');
    btn.innerHTML = PLUS_SVG;
    btn.style.color = 'var(--ttv-rail-accent, var(--ttv-accent, #569cd6))';
    btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (menu) closeMenu(); else openMenu(btn);
    });
    rail.insertBefore(btn, rail.firstChild); // top of the rail
    return true;
  }

  // Re-inject after tab re-renders. Observe the tab area subtree; the rail is
  // recreated on each render so our button needs re-adding.
  var pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    var raf = window.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
    raf(function () { pending = false; injectRailButton(); });
  }
  (function boot() {
    var tries = 0;
    var attached = false;
    function attach() {
      var rail = document.querySelector('.ttvtab-rail');
      if (!rail) return false;
      injectRailButton();
      var host = rail.closest('[data-slot]') || rail.parentNode || document.body;
      try { new MutationObserver(schedule).observe(host, { childList: true, subtree: true }); attached = true; } catch (e) {}
      return true;
    }
    var iv = setInterval(function () {
      if (attach() || ++tries > 60) clearInterval(iv);
    }, 250);
    attach();
    // Backstop: re-assert periodically in case the observed node is replaced.
    setInterval(function () { if (!attached) attach(); else injectRailButton(); }, 2000);
  })();

  // ---- Settings → New Tab (configure the launch command) ----
  tv.contributes.settingsTab({
    id: 'mobile-cc-new-tab',
    title: 'New Tab',
    render: function (container) {
      container.innerHTML = '';
      var intro = document.createElement('p');
      intro.style.cssText = 'color:var(--ttv-muted);font-size:12px;margin:0 0 16px;';
      intro.textContent = 'The ＋ button in the header creates new sessions. "Claude tab" and "Claude in project" launch this command in the new shell:';
      container.appendChild(intro);

      var inp = document.createElement('input');
      inp.type = 'text';
      inp.value = launchCmd();
      inp.placeholder = DEFAULT_CMD;
      inp.autocapitalize = 'off'; inp.autocomplete = 'off'; inp.spellcheck = false;
      inp.style.cssText =
        'width:100%;box-sizing:border-box;background:var(--ttv-bg,#1e1e1e);color:var(--ttv-fg);' +
        'border:1px solid var(--ttv-border,#3a3a3a);border-radius:6px;padding:8px 10px;font:inherit;font-size:14px;';
      inp.addEventListener('change', function () {
        var v = inp.value.trim();
        STORE.set('command', v || DEFAULT_CMD);
        if (!v) inp.value = DEFAULT_CMD;
      });
      container.appendChild(inp);

      var hint = document.createElement('div');
      hint.style.cssText = 'color:var(--ttv-muted);font-size:11px;margin-top:6px;';
      hint.textContent = 'e.g. claude, claude --resume, or your own launcher (ccpc). Default: claude.';
      container.appendChild(hint);
    },
  });
})();
