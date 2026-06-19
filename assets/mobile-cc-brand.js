// mobile-cc-brand — small logo glyph in the header, no title row.
//
// Replaces the upstream ttyview-app-name plugin (which rendered the
// --app-name text in the top-bar slot, costing a full row of vertical
// space on a phone). The brand mark is the same terminal-card glyph as
// the launcher icon, folded into the header row left of the pane
// picker. The instance name (from GET /api/instance, populated by
// --app-name) still reaches document.title — that's what the OS task
// switcher and the PWA window label show — and the glyph's tooltip.
(function () {
  var tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) return;

  // Paint the tabs utility rail (the ▦ all / 🕘 recent strip) in the
  // brand coral. ttyview-tabs reads --ttv-rail-accent (falling back to
  // the host theme accent when unset); mobile-cc opts into its brand
  // color here so the rail matches the launcher icon + header glyph.
  // Theme-independent on purpose — it's identity, not a palette choice.
  try {
    document.documentElement.style.setProperty('--ttv-rail-accent', '#E8896B');
  } catch (e) {}

  // Tweaks to the project-group header row (upstream ttyview-tabs),
  // mobile-cc scoped so ttyview/tmux-web pins are unaffected:
  //   1. Hide the per-group color-identity dot — the colored left
  //      bracket already conveys the group color, so the dot reads as
  //      noise on a phone. Status dots (waiting/active/attention) are a
  //      different class (.ttvtab-dot) and stay.
  //   2. Replace the collapse/expand caret (▸/▾) with a crisp SVG
  //      chevron. The unicode triangles render tiny and thin even when
  //      scaled up; an SVG with a thick stroke is legible and a proper
  //      touch target. Container is sized to a 24px tap box and the
  //      glyph centered inside; font-size:0 suppresses the residual
  //      unicode char between the swap.
  try {
    var st = document.createElement('style');
    st.textContent =
      '.ttvtab-ghead .ttvtab-gdot { display: none !important; }' +
      '.ttvtab-ghead .ttvtab-gcaret {' +
      '  display: inline-flex; align-items: center; justify-content: center;' +
      '  width: 24px; height: 24px; font-size: 0; opacity: 0.9;' +
      '}' +
      '.ttvtab-ghead .ttvtab-gcaret svg { display: block; }';
    document.head.appendChild(st);
  } catch (e) {}

  // CSS can't select by text content and the caret carries no
  // collapsed-state class, so the glyph→SVG swap happens in the DOM and
  // is re-applied after each tabs re-render (MutationObserver on the
  // tab area). One down-chevron, rotated -90deg for the collapsed
  // (▸, right-pointing) state.
  function svgCaret(dir) {
    var rot = dir === 'right' ? ' style="transform:rotate(-90deg)"' : '';
    return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" ' +
      'stroke="currentColor" stroke-width="3" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true"' + rot +
      '><polyline points="6 9 12 15 18 9"/></svg>';
  }
  function upgradeCarets() {
    var carets = document.querySelectorAll('.ttvtab-ghead .ttvtab-gcaret');
    for (var i = 0; i < carets.length; i++) {
      var c = carets[i];
      var t = (c.textContent || '').trim();
      // Only touch spans still showing the unicode glyph — after the
      // swap textContent is empty, so this is a no-op and can't loop.
      if (t === '▾' || t === '▸') {
        c.innerHTML = svgCaret(t === '▸' ? 'right' : 'down');
      }
    }
  }
  var pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    var raf = window.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
    raf(function () { pending = false; upgradeCarets(); });
  }
  try {
    var attached = false;
    function ensureObserver() {
      if (attached) { schedule(); return true; }
      var caret = document.querySelector('.ttvtab-gcaret');
      var target = caret && (caret.closest('[data-slot]') || caret.parentNode);
      if (!target) return false;
      new MutationObserver(schedule).observe(target, { childList: true, subtree: true });
      attached = true;
      schedule();
      return true;
    }
    // Tabs may not be mounted when this plugin loads — retry until the
    // tab area appears, then let the observer drive. A slow fallback
    // tick re-runs the swap in case the observed slot is ever replaced.
    var tries = 0;
    var boot = setInterval(function () {
      if (ensureObserver() || ++tries > 40) clearInterval(boot);
    }, 250);
    ensureObserver();
    setInterval(schedule, 2000);
  } catch (e) {}

  // Inline copy of assets/pwa/icons artwork (terminal card on coral).
  // The title-bar dots are dropped — invisible at glyph size.
  // 16px = the header controls' text line height; the mark should sit
  // in the line like a character, not dominate the row.
  var GLYPH_SVG =
    '<svg width="16" height="16" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<defs><linearGradient id="mccg" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#E8896B"/><stop offset="1" stop-color="#C75B3A"/>' +
    '</linearGradient></defs>' +
    '<rect width="512" height="512" rx="100" fill="url(#mccg)"/>' +
    '<rect x="76" y="116" width="360" height="280" rx="44" fill="#1b1714"/>' +
    '<path d="M150 196 L256 256 L150 316" stroke="#E8896B" stroke-width="44" ' +
    'stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
    '<rect x="284" y="296" width="76" height="40" rx="12" fill="#EDE6DD"/>' +
    '</svg>';

  tv.contributes.headerWidget({
    id: 'mobile-cc-brand',
    name: 'mobile-cc logo',
    preferredSlot: 'header-left',
    render: function (slot) {
      var span = document.createElement('span');
      span.style.cssText =
        'display:inline-flex;align-items:center;padding:0 2px 0 4px;';
      span.innerHTML = GLYPH_SVG;
      slot.appendChild(span);

      var cancelled = false;
      var origTitle = document.title;
      fetch('/api/instance')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (info) {
          if (cancelled || !info || !info.name) return;
          span.title = info.name;
          // Task-switcher / browser-tab label; the in-page header
          // deliberately shows only the mark.
          document.title = info.name;
        })
        .catch(function () {});

      return function unmount() {
        cancelled = true;
        document.title = origTitle;
        span.remove();
      };
    },
  });
})();
