// BAATS Mobile service worker: keeps the app shell so the app opens quickly and shows
// a clear message when the BAATS server cannot be reached. API calls are never cached.
const CACHE = 'baats-mobile-v1';
const SHELL = ['/m/', '/m/manifest.webmanifest', '/m/icon.svg', '/m/icon-192.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith('/m/')) return;
  // Network first, so a new version of BAATS is picked up at once; the cache is the fallback.
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match('/m/'))));
});
