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

  // Paint the tabs utility rail (the ▦ all / 🕘 recent strip), the
  // command chips, and the tab edge accents in the theme's blue accent.
  // ttyview-tabs / mobile-cc-commands read --ttv-rail-accent; we point it
  // at the host theme accent (--ttv-accent, blue by default) so the rail
  // matches the Send button / active tab instead of the coral brand color.
  // Tracks the theme accent if it changes; #569cd6 is the stock blue.
  try {
    document.documentElement.style.setProperty('--ttv-rail-accent', 'var(--ttv-accent, #569cd6)');
    // …and the TEXT-accent var (chips/brand text read it). The light theme
    // defines it per-theme; on dark it was undefined → a coral fallback, so
    // pin it to the blue accent here. Single blue accent, zero coral.
    document.documentElement.style.setProperty('--ttv-rail-accent-text', 'var(--ttv-accent, #569cd6)');
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
      '.ttvtab-ghead .ttvtab-gcaret svg { display: block; }' +
      // Upstream dims inactive rail icons to opacity 0.5, which reads as
      // "darker than the rest" next to the full-strength chips. Brighten
      // the inactive state; the active mode still stands out via its
      // bordered background box (and stays at opacity 1).
      '.ttvtab-rail .ttvtab svg { opacity: 0.9 !important; }' +
      '.ttvtab-rail .ttvtab.active svg { opacity: 1 !important; }' +
      // Enlarge the "Reload app" icon (ttyview-reload ships a fixed 14px
      // icon → ~24px button, shorter than the ~29px bar) so its button
      // matches #refresh and the other header controls. Fixed size, not
      // height:100% — a stretch/100% approach fed back into the flex
      // line cross-size and ballooned the whole bar.
      'button[title="Reload app"] svg { width: 18px !important; height: 18px !important; }' +
      // The header widget containers are inline spans, so their inline-flex
      // children sit on the text baseline and leave descender space below —
      // which inflates the container (and thus the bar) once the icons grow.
      // Make the containers flex+centered so their height tracks the tallest
      // control exactly, with no baseline gap.
      // Containers flex+centered (kills the baseline-descender gap) AND
      // gap:4px so the ⇕/⟳ nested here are spaced like the header's own
      // direct-child buttons (header has gap:4px) — otherwise ⟳ butts
      // right against ⇕ with no gap.
      '#header-left-widgets, #header-widgets { display: inline-flex; align-items: center; gap: 4px; }' +
      // Declutter: hide the redundant top-bar font controls (A−/↔/A+).
      // They live in the ⇕ Terminal-size popover as proxy buttons that
      // .click() these originals — which still fires while display:none,
      // so the popover keeps working and the bar loses 3 buttons.
      'header .font-ctl, #font-down, #font-fit, #font-up { display: none !important; }' +
      // Alignment: upstream ships header buttons at 25/28/29px and varying
      // widths (25-36px). Pin them all to one height AND, for the icon
      // buttons, one width — excluding the pane picker, which must stretch
      // to show the session name. Zero side padding + centered content so
      // the fixed width is exact.
      'header button { height: 29px !important; box-sizing: border-box !important; }' +
      'header button:not(#pane-picker-btn) { width: 32px !important; padding-left: 0 !important; padding-right: 0 !important; justify-content: center !important; }';
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

  // Inline copy of assets/pwa/icons artwork (terminal card on a blue
  // gradient). The title-bar dots are dropped — invisible at glyph size.
  // The cream input-cursor block ("white horizontal strip") is dropped
  // too, leaving just the prompt chevron. 16px = the header controls'
  // text line height; the mark should sit in the line like a character,
  // not dominate the row. 28px ≈ the header button height, so the mark
  // fills the bar like #refresh without the height:100%/stretch feedback
  // loop that ballooned the row.
  var GLYPH_SVG =
    '<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" ' +
    'width="28" height="28" style="display:block">' +
    '<defs><linearGradient id="mccg" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#569cd6"/><stop offset="1" stop-color="#2f6aa8"/>' +
    '</linearGradient></defs>' +
    '<rect width="512" height="512" rx="100" fill="url(#mccg)"/>' +
    '<rect x="76" y="116" width="360" height="280" rx="44" fill="#15181d"/>' +
    '<path d="M150 196 L256 256 L150 316" stroke="#cfe3f7" stroke-width="44" ' +
    'stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
    '</svg>';

  tv.contributes.headerWidget({
    id: 'mobile-cc-brand',
    name: 'mobile-cc logo',
    preferredSlot: 'header-left',
    render: function (slot) {
      var span = document.createElement('span');
      // Centered, fixed-size glyph (28px set on the SVG). Horizontal
      // padding keeps it off the pane picker.
      span.style.cssText =
        'display:inline-flex;align-items:center;padding:0 6px 0 2px;';
      span.innerHTML = GLYPH_SVG;
      slot.appendChild(span);

      var cancelled = false;
      var origTitle = document.title;
      // ttyview-core hardcodes `<span class="title">ttyview</span>` in the
      // header. CSS hides it on narrow viewports, so a phone shows only our
      // glyph — but on desktop the stale "ttyview" text sits next to the
      // mobile-cc mark. Retitle it to the instance name (--app-name) so the
      // desktop header reads as mobile-cc. Restored on unmount.
      var headerTitle = document.querySelector('header .title');
      var origHeaderText = headerTitle ? headerTitle.textContent : null;
      fetch('/api/instance')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (info) {
          if (cancelled || !info || !info.name) return;
          span.title = info.name;
          // Task-switcher / browser-tab label; the in-page header on a
          // phone shows only the mark, desktop shows the name too.
          document.title = info.name;
          if (headerTitle) headerTitle.textContent = info.name;
        })
        .catch(function () {});

      return function unmount() {
        cancelled = true;
        document.title = origTitle;
        if (headerTitle && origHeaderText != null) headerTitle.textContent = origHeaderText;
        span.remove();
      };
    },
  });
})();
