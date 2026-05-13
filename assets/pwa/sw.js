// mobile-cc service worker — minimal "install + skip-waiting + fetch-passthrough"
//
// Scope: pure foundation. This SW makes the page installable as a PWA
// (Chrome won't show the install prompt without a registered SW) and
// preserves online behavior. It deliberately does NOT cache responses
// — caching CC's live transcript or pane state would silently serve
// stale data, which is worse than no offline mode. Add caching strategies
// (and a versioned cache key) only if/when offline-shell needs them.
//
// Future scope (post-foundation, documented in mobile-cc CLAUDE.md):
//   - Cache the shell assets (index.html, /plugins/installed/*/source)
//     with a stale-while-revalidate strategy + a versioned cache key.
//     The cache key MUST include the mobile-cc binary version so a
//     daemon upgrade evicts old plugin sources.
//   - Web Push event handlers (`self.addEventListener('push', ...)` +
//     `notificationclick`) for the "CC asked for permission" alerts.
//     Daemon-side VAPID setup is a separate workstream tracked in
//     mobile-cc CLAUDE.md's PWA section.

const SW_VERSION = '0.0.1-foundation';

self.addEventListener('install', (event) => {
  // Activate immediately instead of waiting for old tabs to close.
  // Safe here because we don't cache anything; if/when caching lands,
  // re-evaluate: a hot-swap mid-session could serve mixed-version assets.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Pure passthrough. /api/* and /ws are obviously never cacheable —
  // they're live state — and the shell assets aren't cached either
  // (see file header). Letting the browser handle the fetch natively
  // is correct + observable in DevTools.
  return;
});

// Future: push + notificationclick handlers will register here.
// self.addEventListener('push', (event) => { ... });
// self.addEventListener('notificationclick', (event) => { ... });
