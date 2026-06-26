// mobile-cc-light-theme — a light, WCAG-AA theme alongside stock Dark + Terminal
// Green. Light background, dark text, brand-coral (#0a5ad6) accent family.
//
// How it works (see ttyview-core ui/index.html theme system):
//   • tv.contributes.theme({ id, name, vars, palette16 }) — `vars` are written
//     to :root as CSS custom properties; `palette16` swaps the terminal's ANSI
//     16-color palette for a light-bg-tuned one (ui/index.html made
//     TTV_PALETTE_16 theme-aware via window.__ttvSetAnsiPalette).
//   • Every surface that reads these vars (terminal grid, tabs + group headers
//     + dots, settings panel, menus/popovers, command chips, quick-keys, the
//     rail, Message-Regions) flips to light automatically.
//
// Contrast (WCAG-AA, vs the surface they sit on):
//   --ttv-fg  #1b1f24 on #f5f6f8 ≈ 15:1 (AAA) · --ttv-muted #5b6470 ≈ 4.6:1 (AA)
//   --ttv-accent #c25a3a (text/links) ≈ 4.5:1 (AA). The BRAND coral #0a5ad6 is
//   only 2.55:1 on white, so it stays for vivid *fills/indicators* via
//   --ttv-rail-accent (rail icons, active-tab bar, dots) where it's not text.
(function () {
  var tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) return;

  var ID = 'mobile-cc-light';

  tv.contributes.theme({
    id: ID,
    name: 'Light',
    vars: {
      // Core surfaces
      '--ttv-bg':            '#f5f6f8', // page
      '--ttv-fg':            '#1b1f24', // primary text (~15:1)
      '--ttv-bg-elev':       '#ffffff', // elevated (cards / header / chips)
      '--ttv-bg-elev2':      '#e8ebef', // deeper wells
      '--ttv-border':        '#c7cdd6', // visible borders (no invisible edges)
      '--ttv-accent':        '#0a5ad6', // AA-safe coral for accent TEXT / links
      '--ttv-muted':         '#5b6470', // secondary text (~4.6:1)
      // Chrome / controls
      '--ttv-control-bg':       '#ffffff',
      '--ttv-control-bg-hover': '#eceff3',
      '--ttv-control-border':   '#c7cdd6',
      '--ttv-divider':          '#dfe3e8',
      '--ttv-faint':            '#7a828d', // faint glyphs (chevrons / separators)
      '--ttv-fg-dim':           '#41474f', // dimmed-but-legible text
      '--ttv-panel-bg':         '#ffffff', // settings / overlay panels
      '--ttv-accent-2':         '#0a5ad6', // info blue (AA on white)
      '--ttv-tint-ok':          '#ecf6ef', // success/built-in badge tint
      '--ttv-tint-info':        '#e8f0fc', // active/info badge tint
      // Shadows + scrim (soft on light, not the dark theme's heavy black)
      '--ttv-shadow':       'rgba(20, 24, 30, 0.16)',
      '--ttv-shadow-soft':  'rgba(20, 24, 30, 0.10)',
      '--ttv-scrim':        'rgba(20, 24, 30, 0.40)',
      // Keep the VIVID brand coral for non-text fills (rail icons, active-tab
      // indicator, status dots). 2.55:1 on white — fine as a bold fill, not text.
      '--ttv-rail-accent':  '#0a5ad6',       // vivid brand fill (borders/indicators)
      '--ttv-rail-accent-text': '#0a5ad6',   // AA-safe coral for brand TEXT on light
      // status dots — darkened so they read on a light rail (>=3:1)
      '--ttv-dot-waiting':   '#a8730a',
      '--ttv-dot-active':    '#1763d6',
      '--ttv-dot-attention': '#b5560a',
    },
    // ANSI 16 tuned for a light background (VS Code light-terminal set): the
    // dark palette's bright yellow/green/white wash out on white, so green/
    // yellow darken and "white" becomes a readable gray.
    palette16: [
      '#000000', '#cd3131', '#008a14', '#8a8a00', '#0451a5', '#bc05bc', '#0598bc', '#555555',
      '#7a828d', '#cd3131', '#0a9a16', '#8a8a00', '#0451a5', '#bc05bc', '#0598bc', '#1b1f24',
    ],
  });

  // color-scheme isn't a custom property, so drive it imperatively: light while
  // this theme is active, otherwise back to the :root default (dark). Keeps
  // native form controls / scrollbars in the right mode.
  function syncColorScheme(id) {
    try {
      document.documentElement.style.colorScheme = (id === ID) ? 'light' : '';
    } catch (e) { /* ignore */ }
  }
  tv.on('theme-activated', function (e) { syncColorScheme(e && e.id); });
  // Apply now in case this theme is already the restored-active one at load.
  try {
    if (tv._internal && tv._internal.getActiveThemeId &&
        tv._internal.getActiveThemeId() === ID) {
      syncColorScheme(ID);
    }
  } catch (e) { /* ignore */ }
})();
