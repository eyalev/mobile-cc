// mobile-cc-width — comfortable, adjustable content width on desktop +
// submit-path diagnostics.
//
// Three jobs, all client-side (no ttyview-core edit, no tmux churn beyond
// the cap-driven window resize the core already does):
//
//  1) DEFAULT CAP 90. ttyview-core caps the terminal at `ttv-max-cols`
//     columns and CENTERS it on wide viewports (FIT_DEFAULT_MAX_COLS=120
//     when the key is absent). 120 cols ≈ 1010px reads too wide on a
//     laptop; chat/reading UIs (ChatGPT, Claude.ai, Slack) sit a content
//     column near ~90 chars. We seed `ttv-max-cols=90` once (key-absence
//     guard — a user's later choice always wins).
//
//  2) SETTINGS → DESKTOP WIDTH. A presets + custom-number control that
//     writes `ttv-max-cols` and re-fits live, so the width is adjustable
//     without the DevTools console.
//
//  3) ALIGN THE CHROME. Core centers the TERMINAL but leaves #input-row
//     (the composer) and #input-accessory (command chips / quick keys /
//     pinned-tab grid) full-bleed — so the box you type into sprawls edge
//     to edge while the text it produces floats in a centered column. We
//     mirror #grid-host's live left/right padding onto both rows, so the
//     whole interactive column lines up (ChatGPT-style: only the top bar
//     stays full-bleed). Reactive via a MutationObserver on the host's
//     inline style (centerGrid sets it) + a resize hook.
//
//  4) SUBMIT DIAGNOSTICS. The reported "Enter didn't submit the first
//     time on desktop" is almost certainly the WS not being OPEN yet on a
//     fresh load (submitInput → sendInput returns false → message kept,
//     no clear). We attach a keydown logger to #input-text that records —
//     per Enter — the connection state, isComposing, defaultPrevented,
//     and whether the textarea actually cleared (= confirmed send). Goes
//     to the console (tag [mcc-submit]) AND a localStorage ring buffer
//     (mobile-cc-width.submitlog) so a load-time failure survives the
//     reload for inspection.
(function () {
  var tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) return;
  if (window.__mccWidth) return;             // idempotent across re-evals
  window.__mccWidth = true;

  // ── plain localStorage key (NOT plugin-scoped): ttyview-core's
  //    maxContentCols() reads `ttv-max-cols` directly. Mirror that. ──
  var COLS_KEY = 'ttv-max-cols';
  var DEFAULT_COLS = 90;

  function getCols() {
    try {
      var v = parseInt(localStorage.getItem(COLS_KEY), 10);
      if (!isNaN(v) && v >= 0) return v;
    } catch (_) {}
    return DEFAULT_COLS;
  }
  function setCols(n) {
    try { localStorage.setItem(COLS_KEY, String(n)); } catch (_) {}
    applyAppFrame();   // resize the centered app column to the new cap…
    refit();           // …then re-fit the terminal into it
    // centerGrid runs inside autoFit; give it a beat, then realign chrome.
    setTimeout(syncChrome, 60);
    setTimeout(syncChrome, 320);
  }

  // ── Center the WHOLE app as one column ────────────────────────────
  // Per-band padding (syncChrome) lines the composer/tabs up WITH the
  // terminal, but the header, top-bar and the band backgrounds still run
  // edge-to-edge. To make the entire desktop view read as one centered
  // app, cap the <body> width to the terminal column and center it — the
  // header, terminal, composer and tab rows then move together, with the
  // page background showing on either side (phone-app-in-a-frame look).
  // Width tracks the SAME ttv-max-cols cap; cap 0 ("Full width") = no cap.
  var GRID_BASE_HPAD = 6;       // mirror of ttyview-core's #grid-host base
  var SCROLLBAR_ALLOW = 16;     // room for the terminal's vertical scrollbar
  var _cw14 = 0;                // cached monospace char width at 14px
  function charWidth14() {
    if (_cw14 > 0) return _cw14;
    try {
      var probe = document.createElement('span');
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;' +
        "font-family:'JetBrains Mono','Cascadia Code','Fira Code',Menlo,Consolas,monospace;font-size:14px";
      probe.textContent = 'M'.repeat(40);
      document.body.appendChild(probe);
      _cw14 = probe.getBoundingClientRect().width / 40;
      probe.remove();
    } catch (_) { _cw14 = 8.4; }
    return _cw14 || 8.4;
  }
  function columnWidthPx(cols) {
    return Math.round(cols * charWidth14()) + 2 * GRID_BASE_HPAD + SCROLLBAR_ALLOW;
  }
  function applyAppFrame() {
    var b = document.body;
    if (!b) return;
    var cap = getCols();
    var w = cap > 0 ? columnWidthPx(cap) : 0;
    // Only frame when the viewport is genuinely wider than the column
    // (desktop). On a phone the cap never binds, so leave it full-bleed.
    if (cap > 0 && window.innerWidth > w + 24) {
      b.style.maxWidth = w + 'px';
      b.style.marginLeft = 'auto';
      b.style.marginRight = 'auto';
      // A thin rule on each side delineates the centered column without a
      // jarring colour change (html + body share --ttv-bg).
      b.style.borderLeft = '1px solid var(--ttv-border)';
      b.style.borderRight = '1px solid var(--ttv-border)';
    } else {
      b.style.maxWidth = '';
      b.style.marginLeft = '';
      b.style.marginRight = '';
      b.style.borderLeft = '';
      b.style.borderRight = '';
    }
  }

  // Re-run core's fit/center by clicking the existing #font-fit control
  // (the same lever mobile-cc-autofit uses — autoFit isn't on window).
  function refit() {
    if (localStorage.getItem('ttv-autofit') === 'false') { syncChrome(); return; }
    var b = document.getElementById('font-fit');
    if (b) { try { b.click(); } catch (_) {} }
  }

  // ── 1) seed the comfortable default once ──────────────────────────
  try {
    if (localStorage.getItem(COLS_KEY) == null) {
      localStorage.setItem(COLS_KEY, String(DEFAULT_COLS));
    }
  } catch (_) {}

  // ── 1b) desktop-readable tab cards + subtitles ────────────────────
  // ttyview-tabs.js sizes the tab grid for a phone: under mobile-cc's
  // tall-tabs, cards are 44px with a 13px name and an 11px subtitle (the
  // `.ttvtab-tag` second line, e.g. "coordinating mcc swarm"). On the wide
  // CENTERED desktop column those read tiny. Rather than edit the shared
  // core file (ttyview-tabs.js is also used by ttyview/panel/tmux-web and
  // is hot with sibling edits), mobile-cc layers a DESKTOP-ONLY override:
  //   • viewport breakpoint @min-width:768px → enlarge card / name / tag.
  //     Viewport-based, so a narrow phone (≤767px) keeps the compact
  //     sizing untouched — no mobile regression.
  //   • a modest GLOBAL subtitle bump (11→12px) + better contrast (muted →
  //     fg, non-active only so the active-tab accent is preserved) — the
  //     subtitle was the least legible element; this helps phone too.
  // `html body…` adds specificity so the override wins regardless of plugin
  // load order vs ttyview-tabs.js.
  (function injectTabCss() {
    if (document.getElementById('mcc-tab-size-css')) return;
    var s = document.createElement('style');
    s.id = 'mcc-tab-size-css';
    s.textContent = [
      // global subtitle: a touch bigger + readable contrast (non-active)
      'html body.ttv-tall-tabs .ttvtab:not(.ttvtab-railbtn) .ttvtab-tag{font-size:12px;line-height:15px;}',
      'html body.ttv-tall-tabs .ttvtab:not(.ttvtab-railbtn):not(.active) .ttvtab-tag{color:var(--ttv-fg);opacity:0.72;}',
      // desktop: enlarge cards + name + subtitle for the wide centered column
      '@media (min-width:768px){',
      '  html body.ttv-tall-tabs .ttvtab:not(.ttvtab-railbtn){min-height:52px;padding:0 12px;}',
      '  html body.ttv-tall-tabs .ttvtab:not(.ttvtab-railbtn) .ttvtab-label,',
      '  html body.ttv-tall-tabs .ttvtab:not(.ttvtab-railbtn).has-tag .ttvtab-label{font-size:16px;line-height:19px;}',
      '  html body.ttv-tall-tabs .ttvtab:not(.ttvtab-railbtn) .ttvtab-tag{font-size:14px;line-height:17px;}',
      '}',
    ].join('');
    (document.head || document.documentElement).appendChild(s);
  })();

  // ── 3) mirror the terminal column onto composer + accessory ───────
  function host() { return document.getElementById('grid-host'); }
  function syncChrome() {
    var h = host();
    if (!h) return;
    var cs = getComputedStyle(h);
    var pl = cs.paddingLeft, pr = cs.paddingRight;
    ['input-row', 'input-accessory', 'below-grid'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      // Only touch horizontal padding; the rows keep their own vertical
      // padding / borders. When the terminal is full-width (phone, or
      // "Full width" cap) grid-host padding is the ~6px base → chrome
      // also goes full width. No max-width needed: matching the host's
      // padding reproduces the exact centered column geometry.
      el.style.paddingLeft = pl;
      el.style.paddingRight = pr;
    });
  }
  // React to centerGrid (it mutates #grid-host inline style) + resize.
  function startSync() {
    var h = host();
    if (!h) { setTimeout(startSync, 300); return; }
    try {
      var mo = new MutationObserver(function () { syncChrome(); });
      mo.observe(h, { attributes: true, attributeFilter: ['style'] });
    } catch (_) {}
    window.addEventListener('resize', function () {
      setTimeout(function () { applyAppFrame(); syncChrome(); }, 80);
    });
    try { tv.on('grid-loaded', function () { setTimeout(syncChrome, 80); }); } catch (_) {}
    try { tv.on('pane-changed', function () { setTimeout(syncChrome, 80); }); } catch (_) {}
    applyAppFrame();
    syncChrome();
  }
  startSync();
  // Belt-and-suspenders: re-fit shortly after boot so the seeded cap
  // lands even if the first autoFit ran before this plugin evaluated.
  setTimeout(function () { applyAppFrame(); refit(); syncChrome(); }, 1600);

  // ── 4) submit diagnostics ─────────────────────────────────────────
  var BOOT = Date.now();
  function connState() {
    var s = document.getElementById('status');
    return {
      connected: !!(s && s.classList.contains('connected')),
      statusText: s ? (s.textContent || '').slice(0, 40) : '(no #status)',
    };
  }
  function pushLog(rec) {
    try {
      var KEY = 'mobile-cc-width.submitlog';
      var arr = [];
      try { arr = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (_) {}
      arr.push(rec);
      if (arr.length > 30) arr = arr.slice(-30);
      localStorage.setItem(KEY, JSON.stringify(arr));
    } catch (_) {}
  }
  function attachSubmitDiag() {
    var ta = document.getElementById('input-text');
    if (!ta) { setTimeout(attachSubmitDiag, 400); return; }
    // CAPTURE phase on document → runs BEFORE core's target-phase keydown
    // handler on #input-text. This matters: core's handler (registered at
    // script eval, before plugins) calls submitInput() synchronously, which
    // CLEARS the textarea on a confirmed send. If we read valBefore in the
    // target phase we'd run after core and always see 0. Capturing first
    // gets the true pre-submit length; e.defaultPrevented + the post-tick
    // valAfter then tell us what core did with it.
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      if (e.target !== ta) return;
      var c = connState();
      var valBefore = ta.value.length;   // read BEFORE core can clear it
      setTimeout(function () {
        var valAfter = ta.value.length;
        var sent = (valBefore > 0 && valAfter === 0);
        var verdict =
          e.shiftKey ? 'newline (shift+enter)'
          : e.isComposing ? 'skipped: IME composing'
          : !e.defaultPrevented ? 'NOT HANDLED (core keydown did not fire)'
          : valBefore === 0 ? 'empty (nothing to send)'
          : sent ? 'submitted'
          : !c.connected ? 'FAILED: WS not connected — message kept'
          : 'FAILED: handler ran but value not cleared';
        var rec = {
          t: new Date().toISOString().slice(11, 23),
          msSinceLoad: Date.now() - BOOT,
          verdict: verdict,
          shift: e.shiftKey, composing: e.isComposing, repeat: e.repeat,
          defaultPrevented: e.defaultPrevented,
          connected: c.connected, status: c.statusText,
          valBefore: valBefore, valAfter: valAfter,
          activeEl: (document.activeElement && document.activeElement.id) || '(none)',
        };
        pushLog(rec);
        var bad = verdict.indexOf('FAIL') === 0 || verdict.indexOf('NOT HANDLED') === 0;
        (bad ? console.warn : console.log)('[mcc-submit]', verdict, rec);
      }, 0);
    }, true); // capture phase, before core
  }
  attachSubmitDiag();
  // Expose a quick inspector for the user/agent after a repro.
  window.mccSubmitLog = function () {
    try { return JSON.parse(localStorage.getItem('mobile-cc-width.submitlog') || '[]'); }
    catch (_) { return []; }
  };

  // ── 2) Settings → Desktop Width ───────────────────────────────────
  var PRESETS = [
    { v: 75,  label: 'Narrow',      hint: '~75 cols — tight reading column.' },
    { v: 90,  label: 'Comfortable', hint: '~90 cols — default; chat-app width.' },
    { v: 110, label: 'Wide',        hint: '~110 cols — roomy, still centered.' },
    { v: 0,   label: 'Full width',  hint: 'Fill the window; no centering.' },
  ];
  tv.contributes.settingsTab({
    id: 'mobile-cc-width',
    title: 'Desktop Width',
    render: function (container) {
      container.innerHTML = '';
      var intro = document.createElement('p');
      intro.style.cssText = 'color:var(--ttv-muted);font-size:12px;margin:0 0 14px;';
      intro.textContent = 'How wide the centered terminal column is on a desktop/laptop. ' +
        'The composer and tab rows line up under it. Phones always fill the width.';
      container.appendChild(intro);

      var cur = getCols();
      var custom; // forward ref to the number input

      function selectVal(v) {
        setCols(v);
        Array.prototype.forEach.call(container.querySelectorAll('input[name="mcc-w"]'), function (rb) {
          rb.checked = (parseInt(rb.value, 10) === v);
        });
        if (custom) custom.value = String(v);
      }

      PRESETS.forEach(function (o) {
        var row = document.createElement('label');
        row.style.cssText = 'display:flex;align-items:flex-start;gap:10px;margin-bottom:12px;cursor:pointer;';
        var rb = document.createElement('input');
        rb.type = 'radio'; rb.name = 'mcc-w'; rb.value = String(o.v);
        rb.checked = (cur === o.v);
        rb.style.cssText = 'width:18px;height:18px;flex:none;margin-top:1px;';
        rb.addEventListener('change', function () { if (rb.checked) selectVal(o.v); });
        row.appendChild(rb);
        var txt = document.createElement('div');
        var t = document.createElement('div');
        t.textContent = o.label; t.style.cssText = 'color:var(--ttv-fg);font-size:14px;';
        var h = document.createElement('div');
        h.textContent = o.hint; h.style.cssText = 'color:var(--ttv-muted);font-size:11px;margin-top:2px;';
        txt.appendChild(t); txt.appendChild(h); row.appendChild(txt);
        container.appendChild(row);
      });

      var crow = document.createElement('div');
      crow.style.cssText = 'display:flex;align-items:center;gap:10px;margin-top:16px;';
      var clabel = document.createElement('span');
      clabel.textContent = 'Custom columns'; clabel.style.cssText = 'color:var(--ttv-fg);font-size:13px;';
      custom = document.createElement('input');
      custom.type = 'number'; custom.min = '0'; custom.max = '300'; custom.step = '5';
      custom.value = String(cur);
      custom.style.cssText = 'width:90px;padding:6px 8px;background:var(--ttv-bg-elev);' +
        'border:1px solid var(--ttv-border);border-radius:6px;color:var(--ttv-fg);font-size:14px;';
      custom.addEventListener('change', function () {
        var v = parseInt(custom.value, 10);
        if (isNaN(v) || v < 0) v = 0;
        if (v > 300) v = 300;
        custom.value = String(v);
        selectVal(v);
      });
      crow.appendChild(clabel); crow.appendChild(custom);
      var chint = document.createElement('span');
      chint.textContent = '0 = full width'; chint.style.cssText = 'color:var(--ttv-muted);font-size:11px;';
      crow.appendChild(chint);
      container.appendChild(crow);
    },
  });
})();
