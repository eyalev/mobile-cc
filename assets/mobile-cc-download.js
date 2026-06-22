// mobile-cc-download — linkify paths + URLs in the terminal; tap one for an
// action menu.
//
// Tapping an underlined token opens a small custom popover (NOT Android's
// native selection bar) with context actions:
//   * file path → ⬇ Download, ⧉ Copy
//   * URL       → ↗ Open,     ⧉ Copy
//   * ambiguous (host.tld/path, no scheme) → ↗ Open, ⬇ Download, ⧉ Copy
// "Open" ALWAYS goes to the external/default browser — never an in-app Custom
// Tab, never the PWA window: native shell → ACTION_VIEW intent (LastScreenshot
// plugin's openUrl); PWA → window.open(_blank) (a real Chrome tab). "Download"
// hits /api/download ($HOME-allowlisted). A deliberate long-press still
// selects text for native Copy/Share — we only act on a short tap.
//
// Structural constraints (ttyview-core cell-grid): the grid reuses cell
// <span>s and applies cell-diffs in place, so we must NOT wrap/restructure
// cells (breaks diff-by-position) — we only ADD classes. A MutationObserver
// rescans changed/new rows; frozen scrollback rows scan once; the tapped token
// is reconstructed live from the DOM. Works in the PWA and the native shell.
(function () {
  var tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) {
    console.warn('[mobile-cc-download] requires apiVersion 1');
    return;
  }

  var MENU_ID = 'mcc-link-menu';

  // URL: scheme:// or www.  Path: a slash-bearing run of path chars.
  var URL_RE = /(?:https?:\/\/|www\.)[^\s]+/gi;
  var PATH_RE = /[A-Za-z0-9._+@~-]*(?:\/[A-Za-z0-9._+@~-]+)+\/?/g;

  function injectStyle() {
    if (document.getElementById('mcc-download-styles')) return;
    var s = document.createElement('style');
    s.id = 'mcc-download-styles';
    s.textContent =
      '.ttv-cell.mcc-link{text-decoration:underline;text-decoration-thickness:1px;' +
      'text-underline-offset:2px;cursor:pointer;}' +
      '.ttv-cell.mcc-path{text-decoration-color:var(--ttv-rail-accent,var(--ttv-accent,#E8896B));}' +
      '.ttv-cell.mcc-url{text-decoration-color:#5B9BD5;}' +
      '#' + MENU_ID + '{position:fixed;z-index:100000;display:flex;flex-direction:column;' +
      'min-width:150px;background:var(--ttv-bg-elev2,#222);border:1px solid var(--ttv-border,#444);' +
      'border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.5);overflow:hidden;}' +
      '#' + MENU_ID + ' button{appearance:none;background:none;border:none;color:var(--ttv-fg,#eee);' +
      'font:500 15px system-ui,sans-serif;text-align:left;padding:12px 16px;cursor:pointer;}' +
      '#' + MENU_ID + ' button:active{background:var(--ttv-bg-elev,#333);}' +
      '#' + MENU_ID + ' button+button{border-top:1px solid var(--ttv-border,#3a3a3a);}';
    document.head.appendChild(s);
  }

  // ---- token classification ---------------------------------------------
  //
  // A bare slash token (client/server, TCP/IP, and/or, .mp4/.gif/demo) is
  // PROSE, not a path. Only treat a slash token as a path when it's clearly
  // one: rooted (/, ~, ./, ../), ends in a file extension, or is an explicit
  // directory (trailing slash with ≥2 segments). This kills the prose-slash
  // false positives while keeping demos/run.sh, .github/workflows/x.yml,
  // docs/media/, etc.
  function isPathLike(tok) {
    if (tok.indexOf('/') < 0) return false;
    if (/^(?:~|\/|\.\.?\/)/.test(tok)) return true;            // rooted / ~ / ./ ../
    if (/[^.\/]\.[A-Za-z0-9]{1,8}$/.test(tok)) return true;    // ends in a file extension
    if (/\/$/.test(tok) && tok.split('/').filter(Boolean).length >= 2) return true; // dir/
    return false;
  }

  function classify(tok) {
    if (/^(?:https?:\/\/|www\.)/i.test(tok)) return 'url';
    if (/^(?:~|\/|\.\.?\/)/.test(tok)) return 'path';
    if (/[^.\/]\.[A-Za-z0-9]{1,8}$/.test(tok)) return 'path';  // ends in a file ext → local path
    if (/^[a-z0-9.-]+\.[a-z]{2,}\//i.test(tok)) return 'ambiguous'; // host.tld/path, no scheme
    return 'path';
  }

  // ---- actions ----------------------------------------------------------
  function basename(p) { var a = p.split('/'); return a[a.length - 1] || 'download'; }

  function isNative() {
    var c = window.Capacitor;
    return !!(c && typeof c.isNativePlatform === 'function' && c.isNativePlatform());
  }
  var _plugin;
  function nativePlugin() {
    if (!_plugin && window.Capacitor && window.Capacitor.registerPlugin) {
      _plugin = window.Capacitor.registerPlugin('LastScreenshot');
    }
    return _plugin;
  }

  function flash(msg) { try { if (tv.toast) tv.toast(msg); } catch (e) {} }

  function doDownload(path) {
    var url = '/api/download?path=' + encodeURIComponent(path);
    var a = document.createElement('a');
    a.href = url; a.download = basename(path); a.rel = 'noopener';
    document.body.appendChild(a); a.click();
    setTimeout(function () { a.remove(); }, 0);
  }

  function isAndroid() { return /Android/i.test(navigator.userAgent || ''); }

  // Open ALWAYS in the external browser. The hard case is the standalone PWA:
  // window.open() is captured back INTO the PWA window (a known, unstandardized
  // limitation — w3c/manifest#989), so on Android we escape via a Chrome
  // intent: URI (action=VIEW, package=com.android.chrome) which forces a real
  // Chrome tab; browser_fallback_url covers the (here-impossible) no-Chrome
  // case. Native shell uses the ACTION_VIEW intent directly; desktop/iOS get a
  // normal new tab.
  function doOpen(tok) {
    var url = /^https?:\/\//i.test(tok) ? tok : 'https://' + tok; // www. → https
    if (isNative()) {
      try { nativePlugin().openUrl({ url: url }); return; } catch (e) {}
    }
    if (isAndroid()) {
      var scheme = url.slice(0, url.indexOf(':'));              // http | https
      var rest = url.replace(/^https?:\/\//i, '');              // host/path?query#frag
      // A '#' or ';' in the URL would break — or be used to HIJACK — the
      // intent: URI grammar: Android parses the first '#Intent;...;end', so an
      // embedded '#Intent;...' in attacker-influenced terminal text could
      // inject arbitrary intent fields (action/package/...). Only use the
      // intent form for grammar-safe URLs; anything else falls back to a normal
      // new tab (may land in the PWA window, but never launches a forged intent).
      if (rest.indexOf('#') < 0 && rest.indexOf(';') < 0) {
        var intentUrl = 'intent://' + rest + '#Intent;scheme=' + scheme +
          ';package=com.android.chrome;action=android.intent.action.VIEW;' +
          'S.browser_fallback_url=' + encodeURIComponent(url) + ';end';
        window.location.href = intentUrl;
        return;
      }
    }
    window.open(url, '_blank');
  }

  function doCopy(tok) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(tok).then(function () { flash('Copied'); },
          function () { flash('Copy failed'); });
        return;
      }
    } catch (e) {}
    // Fallback for non-secure contexts.
    var ta = document.createElement('textarea');
    ta.value = tok; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); flash('Copied'); } catch (e) {}
    ta.remove();
  }

  // ---- the popover menu --------------------------------------------------
  function closeMenu() {
    var m = document.getElementById(MENU_ID);
    if (m) m.remove();
    document.removeEventListener('pointerdown', onOutside, true);
    window.removeEventListener('scroll', closeMenu, true);
    window.removeEventListener('resize', closeMenu);
  }
  function onOutside(e) {
    var m = document.getElementById(MENU_ID);
    if (m && !m.contains(e.target)) closeMenu();
  }

  function addBtn(menu, label, fn) {
    var b = document.createElement('button');
    b.type = 'button'; b.textContent = label; b.tabIndex = -1;
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });
    b.addEventListener('pointerup', function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      closeMenu(); fn();
    });
    menu.appendChild(b);
  }

  function openMenu(tok, type, rect) {
    closeMenu();
    var menu = document.createElement('div');
    menu.id = MENU_ID;
    if (type === 'url') {
      addBtn(menu, '↗ Open', function () { doOpen(tok); });
    } else if (type === 'ambiguous') {
      addBtn(menu, '↗ Open', function () { doOpen(tok); });
      addBtn(menu, '⬇ Download', function () { doDownload(tok); });
    } else {
      addBtn(menu, '⬇ Download', function () { doDownload(tok); });
    }
    addBtn(menu, '⧉ Copy', function () { doCopy(tok); });
    document.body.appendChild(menu);

    // Anchor above the token; flip below if it would clip the top.
    var mh = menu.offsetHeight || 96, mw = menu.offsetWidth || 160;
    var top = rect.top - mh - 6;
    if (top < 8) top = Math.min(window.innerHeight - mh - 8, rect.bottom + 6);
    var left = Math.max(8, Math.min(window.innerWidth - mw - 8, Math.round(rect.left)));
    menu.style.top = Math.round(top) + 'px';
    menu.style.left = left + 'px';

    setTimeout(function () {
      document.addEventListener('pointerdown', onOutside, true);
      window.addEventListener('scroll', closeMenu, true);
      window.addEventListener('resize', closeMenu);
    }, 0);
  }

  // ---- linkify scanning --------------------------------------------------
  function rowTextMap(row) {
    var spans = row.children, text = '', map = [];
    for (var i = 0; i < spans.length; i++) {
      var t = spans[i].textContent || '';
      for (var j = 0; j < t.length; j++) { text += t[j]; map.push(spans[i]); }
    }
    return { text: text, map: map };
  }

  function mark(map, start, end, cls, wanted) {
    for (var k = start; k < end; k++) {
      var sp = map[k];
      if (sp) { sp.classList.add('mcc-link', cls); if (wanted.indexOf(sp) < 0) wanted.push(sp); }
    }
  }

  function scanRow(row) {
    if (!row || !row.classList || !row.classList.contains('ttv-row')) return;
    var tm = rowTextMap(row), wanted = [], taken = [];
    var m;
    // URLs first (they contain slashes too; claim those ranges).
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(tm.text))) {
      var u = m[0].replace(/[)\].,;:'"]+$/, ''); // trim trailing punctuation
      if (u.length < 4) continue;
      taken.push([m.index, m.index + u.length]);
      mark(tm.map, m.index, m.index + u.length, 'mcc-url', wanted);
    }
    // Paths in the gaps — only ones that clearly look like paths (isPathLike),
    // so prose slashes (client/server, .mp4/.gif/demo) stay un-underlined.
    PATH_RE.lastIndex = 0;
    while ((m = PATH_RE.exec(tm.text))) {
      var raw = m[0];                       // keep trailing slash for the dir test
      if (raw.length < 3 || !isPathLike(raw)) continue;
      var s = m.index, e = m.index + raw.length;
      var prev = s > 0 ? tm.text[s - 1] : '';
      if (prev === ':' || prev === '/') continue;
      var overlap = taken.some(function (r) { return s < r[1] && e > r[0]; });
      if (overlap) continue;
      mark(tm.map, s, e, 'mcc-path', wanted);
    }
    // Drop stale marks.
    var cur = row.getElementsByClassName('mcc-link');
    for (var a = cur.length - 1; a >= 0; a--) {
      if (wanted.indexOf(cur[a]) < 0) cur[a].classList.remove('mcc-link', 'mcc-path', 'mcc-url');
    }
  }

  function scanAll() {
    var host = document.getElementById('grid-host');
    if (!host) return;
    var rows = host.getElementsByClassName('ttv-row');
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.classList.contains('frozen') && row.dataset.mccScanned) continue;
      scanRow(row);
      if (row.classList.contains('frozen')) row.dataset.mccScanned = '1';
    }
  }

  // Reconstruct the token under a tapped cell, expanding to whitespace bounds.
  function tokenAtCell(cell) {
    var row = cell.parentNode;
    if (!row || !row.classList || !row.classList.contains('ttv-row')) return null;
    var tm = rowTextMap(row), idx = tm.map.indexOf(cell);
    if (idx < 0) return null;
    var lo = idx, hi = idx;
    while (lo > 0 && !/\s/.test(tm.text[lo - 1])) lo--;
    while (hi < tm.text.length - 1 && !/\s/.test(tm.text[hi + 1])) hi++;
    // Trim trailing prose punctuation but keep '/' for the dir test.
    var tok = tm.text.slice(lo, hi + 1).replace(/[)\].,;:'"]+$/, '');
    if (!tok) return null;
    if (/^(?:https?:\/\/|www\.)/i.test(tok)) return tok;
    if (isPathLike(tok)) return tok.replace(/\/$/, '');
    return null;
  }

  // ---- tap handling ------------------------------------------------------
  var downTs = 0, downX = 0, downY = 0;
  function onDown(e) { downTs = Date.now(); downX = e.clientX; downY = e.clientY; }
  function onUp(e) {
    var cell = e.target;
    if (!cell || !cell.classList || !cell.classList.contains('mcc-link')) return;
    if (Date.now() - downTs > 350) return;                          // long-press → native select
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 10) return;
    var tok = tokenAtCell(cell);
    if (!tok) return;
    e.preventDefault(); e.stopPropagation();                        // own the tap
    var rect = cell.getBoundingClientRect();
    openMenu(tok, classify(tok), rect);
  }

  function wire() {
    var host = document.getElementById('grid-host');
    if (!host) return false;
    host.addEventListener('pointerdown', onDown, true);
    host.addEventListener('pointerup', onUp, true);
    var pending = null, t = null;
    function flush() { t = null; var set = pending; pending = null; set.forEach(scanRow); }
    function note(row) {
      if (!row) return;
      if (!pending) pending = new Set();
      pending.add(row);
      if (!t) t = setTimeout(flush, 250);
    }
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var mu = muts[i];
        if (mu.type === 'characterData') {
          var p = mu.target.parentNode, r = p && p.closest && p.closest('.ttv-row');
          note(r);
        } else if (mu.type === 'childList') {
          for (var j = 0; j < mu.addedNodes.length; j++) {
            var n = mu.addedNodes[j];
            if (n.nodeType === 1 && n.classList && n.classList.contains('ttv-row')) note(n);
          }
        }
      }
    }).observe(host, { childList: true, subtree: true, characterData: true });
    return true;
  }

  injectStyle();
  var tries = 0;
  var iv = setInterval(function () {
    if (wire() || ++tries > 60) { clearInterval(iv); scanAll(); }
  }, 250);
  if (wire()) { clearInterval(iv); scanAll(); }
  try { tv.on('grid-loaded', function () { closeMenu(); scanAll(); }); } catch (e) {}
  try { tv.on('pane-changed', function () { closeMenu(); setTimeout(scanAll, 50); }); } catch (e) {}
})();
