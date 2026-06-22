// mobile-cc-tabs — mobile-cc tab UX enhancements.
//
// Phase 1 (this file): opt into the tall two-line tab layout defined in
// ttyview-tabs.js (`body.ttv-tall-tabs`) so each tab shows its name on
// one line and its custom tag (subtitle — "what am I working on") on a
// readable second line, instead of cramming both into the stock 28px.
// Pair with the tabs setting maxPerRow=3 for enough width per tab.
//
// Phase 2 (added below once wired): define window.ttvTagSuggest so the
// inline tag editor shows a ✨ button that AI-generates the subtitle
// from the pane's recent output via Groq (reusing the ttyview-stt-groq
// BYO key). Kept here so all the Groq specifics stay out of upstream
// ttyview-tabs.js — that plugin only renders the button when the hook
// exists.
(function () {
  var tv = window.ttyview;
  if (!tv) return;
  if (window.__mccTabs) return;          // idempotent across re-evals
  window.__mccTabs = true;

  // ---- Phase 1: enable the tall two-line tab layout ----------------
  function enableTall() {
    try { document.body && document.body.classList.add('ttv-tall-tabs'); } catch (_) {}
  }
  enableTall();
  // body may not exist yet on the very first eval in some load orders.
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', enableTall, { once: true });
  }
})();
