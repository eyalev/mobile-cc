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

// Web Push: the daemon (src/push.rs) sends a VAPID-signed, encrypted
// payload { title, body, type, pane? }. We show it and, on tap, focus the
// pane. tag=pane so repeated alerts for the same pane collapse instead of
// stacking. Payload is deliberately minimal (session name only) — it can
// surface on a lock screen.
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (_) {}
  const title = d.title || 'mobile-cc';
  const pane = d.pane || '';
  const url = d.url || (pane ? '/?pane=' + encodeURIComponent(pane) : '/');
  event.waitUntil(self.registration.showNotification(title, {
    body: d.body || '',
    icon: '/pwa/icons/icon-192.png',
    badge: '/pwa/icons/icon-192.png',
    tag: pane || d.type || 'mobile-cc',
    renotify: true,
    // Permission prompts block CC until answered — keep them sticky.
    requireInteraction: d.type === 'permission',
    data: { url },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of cs) {
      if ('focus' in c) {
        c.focus();
        // The page (mobile-cc-push.js) selects the pane on this message —
        // avoids a full reload when the PWA is already open.
        c.postMessage({ type: 'mcc-focus-pane', url });
        return;
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
