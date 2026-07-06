// mobile-cc-toolbar — declutter the top bar: an expand (⋯) button collapses
// the secondary header controls into a dropdown, and Settings → Toolbar lets
// you choose which controls stay pinned in the bar vs live in the ⋯ menu.
//
// The header had ~12 controls (core: pane picker / refresh / font / scroll-to-
// bottom / settings; plugins: brand, search, terminal-size, prompt-nav ▲▼,
// topics, reload…) and no overflow — they just crowded / ran off a phone.
//
// Mechanism (pure DOM, no core change): we DISCOVER every header control (core
// ids + every plugin headerWidget button), then for each one NOT in the pinned
// set we MOVE its real element into a '#mcc-tb-more' dropdown (so listeners are
// preserved). Pinned controls are left untouched in place. A MutationObserver
// re-reconciles when plugins (re)render their widgets late. Pinned set persists
// in scoped storage; default = minimal (pane picker + settings), everything
// else in the ⋯ menu, all reconfigurable.
(function () {
  var tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) {
    console.warn('[mobile-cc-toolbar] requires apiVersion 1');
    return;
  }
  var SELF = tv.storage('mobile-cc-toolbar');
  var MORE_ID = 'mcc-tb-more', BTN_ID = 'mcc-tb-btn';
  // Controls pinned by default; everything else discovered goes to overflow.
  var DEFAULT_PINNED = ['picker', 'settings'];

  function diag(cat, data) { try { if (typeof window.ttvDiag === 'function') window.ttvDiag(cat, data); } catch (e) {} }
  function pinned() {
    var v = SELF.get('pinned');
    return Array.isArray(v) ? v : DEFAULT_PINNED.slice();
  }
  function setPinned(arr) { SELF.set('pinned', arr); }

  function injectStyle() {
    if (document.getElementById('mcc-tb-styles')) return;
    var s = document.createElement('style');
    s.id = 'mcc-tb-styles';
    s.textContent =
      '#' + BTN_ID + ' svg{display:block;width:18px;height:18px;}' +
      '#' + MORE_ID + '{display:none;}' +
      '#' + MORE_ID + '.open{display:flex;position:fixed;z-index:100000;flex-wrap:wrap;gap:6px;' +
        'max-width:84vw;padding:10px;background:var(--ttv-bg-elev2,#222);border:1px solid var(--ttv-border,#444);' +
        'border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.5);align-items:center;}' +
      // give the moved controls comfortable tap room inside the sheet
      '#' + MORE_ID + '.open > *{margin:0;}' +
      '#' + MORE_ID + '.open button,#' + MORE_ID + '.open .font-ctl{min-height:40px;}';
    document.head.appendChild(s);
  }

  // ---- discover header controls -----------------------------------------
  // Each: { key, label, el }. Core controls by id; plugin widgets by scanning
  // the header-right / header-left slots (any button not otherwise claimed).
  var KNOWN_TITLE = {
    'Search your sessions': { key: 'search', label: 'Session search' },
    'Terminal size': { key: 'termsize', label: 'Terminal size' },
    'Topics': { key: 'topics', label: 'Topics' },
  };
  function headerEl() { return document.querySelector('header'); }
  function slug(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24); }

  function discover() {
    var header = headerEl();
    if (!header) return [];
    var items = [], seen = new Set();
    function add(key, label, el) {
      if (!el || seen.has(el) || el.id === BTN_ID || el.id === MORE_ID) return;
      seen.add(el); items.push({ key: key, label: label, el: el });
    }
    // Core controls by UNIQUE id / class — found whether they're still in the
    // header OR already relocated into the overflow panel (which lives under
    // <body>). This is the fix for "a moved control disappears from Settings".
    add('picker', 'Pane picker', document.getElementById('pane-picker-btn'));
    add('refresh', 'Refresh', document.getElementById('refresh'));
    add('font', 'Font size', document.querySelector('.font-ctl'));
    add('scrollbottom', 'Scroll to bottom', document.getElementById('scroll-bottom'));
    add('settings', 'Settings', document.getElementById('settings-btn'));
    add('promptnav', 'Prompt nav (▲▼)', document.getElementById('mcc-pn-tb'));
    // Plugin headerWidget buttons (search, term-size, topics, …): scan the
    // header-right slot AND the overflow panel (a relocated button lives there).
    var containers = [document.getElementById('header-widgets'), $more];
    for (var c = 0; c < containers.length; c++) {
      var cont = containers[c]; if (!cont) continue;
      var kids = cont.children;
      for (var i = 0; i < kids.length; i++) {
        var el = kids[i];
        if (seen.has(el) || el.id === BTN_ID) continue;
        var t = el.getAttribute('title') || el.getAttribute('aria-label') || '';
        var known = KNOWN_TITLE[t];
        if (known) { add(known.key, known.label, el); continue; }
        // Generic per-button item, keyed stably by id/title (skip anonymous).
        if (el.tagName === 'BUTTON') {
          var key = el.id ? ('w-' + el.id) : (t ? 'w-' + slug(t) : '');
          if (key) add(key, t || 'Button', el);
        }
      }
    }
    return items;
  }

  // ---- overflow UI ------------------------------------------------------
  var $more = null, $btn = null;
  function ensureUI() {
    var header = headerEl();
    if (!header) return false;
    if (!$more) {
      $more = document.createElement('span'); $more.id = MORE_ID;
      document.body.appendChild($more);   // floated panel, positioned on open
    }
    return true;
  }
  function closeMore() {
    if ($more) $more.classList.remove('open');
    if ($btn) $btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    window.removeEventListener('resize', onResize);
  }
  function onOutside(e) {
    if ($more && !$more.contains(e.target) && e.target.id !== BTN_ID &&
        !(e.target.closest && e.target.closest('#' + BTN_ID))) closeMore();
  }
  function onResize() { closeMore(); }
  function openMore() {
    if (!$more || !$btn) return;
    $more.classList.add('open');
    $btn.setAttribute('aria-expanded', 'true');
    var r = $btn.getBoundingClientRect();
    var pw = $more.offsetWidth || 220;
    $more.style.top = (r.bottom + 6) + 'px';
    $more.style.left = Math.max(8, Math.min(window.innerWidth - pw - 8, Math.round(r.right - pw))) + 'px';
    setTimeout(function () {
      document.addEventListener('pointerdown', onOutside, true);
      window.addEventListener('resize', onResize);
    }, 0);
  }

  // Move every non-pinned discovered control into the overflow sheet; restore
  // pinned ones to the header. Minimal movement (pinned defaults never move).
  function reconcile() {
    if (!ensureUI()) return;
    var header = headerEl();
    var keep = pinned();
    var items = discover();
    items.forEach(function (it) {
      var isPinned = keep.indexOf(it.key) >= 0;
      var inMore = $more.contains(it.el);
      if (isPinned && inMore) {
        // restore to the header, just before the ⋯ button
        if ($btn && $btn.parentNode === header) header.insertBefore(it.el, $btn);
        else header.appendChild(it.el);
      } else if (!isPinned && !inMore) {
        $more.appendChild(it.el);
      }
    });
    diag('mcc-tb-reconcile', { items: items.length, pinned: keep.length, overflow: $more.children.length });
  }

  // ---- the ⋯ toolbar button (headerWidget, rightmost) -------------------
  injectStyle();
  tv.contributes.headerWidget({
    id: 'mobile-cc-toolbar',
    name: 'Toolbar overflow',
    preferredSlot: 'header-right',
    render: function (slot) {
      $btn = document.createElement('button');
      $btn.id = BTN_ID; $btn.type = 'button';
      $btn.title = 'More controls';
      $btn.setAttribute('aria-label', 'More toolbar controls');
      $btn.setAttribute('aria-haspopup', 'menu');
      $btn.setAttribute('aria-expanded', 'false');
      $btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';
      $btn.addEventListener('click', function (e) {
        e.preventDefault();
        if ($more && $more.classList.contains('open')) closeMore();
        else { reconcile(); openMore(); }
      });
      slot.appendChild($btn);
      setTimeout(reconcile, 0);
      return function unmount() { closeMore(); if ($more) $more.remove(); $more = null; $btn = null; };
    },
  });

  // ---- settings: choose pinned controls ---------------------------------
  tv.contributes.settingsTab({
    id: 'mobile-cc-toolbar',
    title: 'Toolbar',
    render: function (container) {
      container.innerHTML = '';
      var intro = document.createElement('p');
      intro.style.cssText = 'color:var(--ttv-muted);font-size:13px;line-height:1.5;margin:0 0 14px;';
      intro.textContent = 'Choose which controls stay in the top bar. The rest collapse into the ⋯ menu. (Pane picker / Settings recommended to keep pinned.)';
      container.appendChild(intro);

      var keep = pinned();
      var items = discover();
      if (!items.length) {
        var none = document.createElement('div');
        none.style.cssText = 'color:var(--ttv-muted);font-size:13px;';
        none.textContent = 'Open the terminal once, then reopen Settings to list the toolbar controls.';
        container.appendChild(none); return;
      }
      items.forEach(function (it) {
        var row = document.createElement('label');
        row.style.cssText = 'display:flex;align-items:center;gap:10px;font-size:14px;color:var(--ttv-fg);cursor:pointer;padding:7px 0;';
        var cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = keep.indexOf(it.key) >= 0;
        cb.style.cssText = 'width:20px;height:20px;flex:none;';
        cb.addEventListener('change', function () {
          var cur = pinned().slice();
          var at = cur.indexOf(it.key);
          if (cb.checked && at < 0) cur.push(it.key);
          else if (!cb.checked && at >= 0) cur.splice(at, 1);
          setPinned(cur);
          reconcile();
        });
        var span = document.createElement('span'); span.textContent = it.label;
        row.appendChild(cb); row.appendChild(span);
        container.appendChild(row);
      });
    },
  });

  // ---- wiring: reconcile as plugins mount / panes switch ----------------
  var t = null;
  function schedule() { if (t) clearTimeout(t); t = setTimeout(reconcile, 200); }
  function wireObserver() {
    var header = headerEl();
    if (!header) return false;
    new MutationObserver(function () { if (!$more || !$more.classList.contains('open')) schedule(); })
      .observe(header, { childList: true, subtree: true });
    return true;
  }
  var tries = 0;
  var iv = setInterval(function () { if (wireObserver() || ++tries > 60) { clearInterval(iv); schedule(); } }, 250);
  if (wireObserver()) { clearInterval(iv); schedule(); }
  try { tv.on('pane-changed', schedule); } catch (e) {}
  diag('mcc-tb-init', {});
})();
