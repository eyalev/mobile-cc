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
