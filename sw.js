// Ink service worker — bump CACHE_NAME on every deploy.
const CACHE_NAME = 'ink-v31';
const STATIC = ['./', './index.html', './manifest.json', './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(STATIC).catch(() => {})));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Web push ────────────────────────────────────────────────────────────────
// The payload is JSON written by the push-send edge function. `tag` collapses
// repeat nudges for the same challenge into one notification rather than
// stacking a fresh banner every morning.
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Ink', {
    body: d.body || '',
    tag: d.tag || 'ink-challenge',
    renotify: true,
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    data: { url: d.url || './?screen=challenges' },
  }));
});

// Focus an already-open Ink rather than piling up tabs, and only navigate when
// the existing one is somewhere else.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || './?screen=challenges';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if (c.url.includes('/Ink') || c.url.includes('index.html')) {
        return c.focus().then(w => (w && w.navigate ? w.navigate(target) : w));
      }
    }
    return clients.openWindow(target);
  }));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Bypass entirely on localhost so local dev always hits fresh files.
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return;

  // Bypass the SW for Anthropic + Supabase: let the browser fetch them
  // directly. The old network-first-with-cache-fallback branch cached
  // nothing, so on failure caches.match missed and respondWith(undefined)
  // threw "returned response is null". Bypassing lets offline write failures
  // reject natively into the app's outbox (sbFetch queues them).
  if (url.hostname.endsWith('anthropic.com') || url.hostname.endsWith('supabase.co')) return;

  // Cache-first for everything else (static shell).
  e.respondWith(
    caches.match(e.request).then(hit =>
      hit || fetch(e.request).then(res => {
        if (res && res.status === 200 && e.request.method === 'GET') {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() => caches.match('./index.html'))
    )
  );
});
