/* FairwayLink service worker — cache the app shell so the sim runs without a network. */
const CACHE = 'fairwaylink-v1';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'assets/icon.svg',
  'css/style.css', 'data/courses.json',
  'js/physics.js', 'js/terrain.js', 'js/engine.js', 'js/track.js', 'js/app.js'
];
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(SHELL.filter(Boolean));
    // course artwork is optional at install time: add what we can
    try {
      const res = await fetch('data/courses.json');
      const j = await res.json();
      const arts = [];
      j.courses.forEach(course => course.layout.forEach(h => arts.push(h.art)));
      await Promise.allSettled(arts.map(a => c.add(a)));
      await Promise.allSettled(j.courses.map(course => c.add(course.label)));
    } catch (err) { /* offline install: fine */ }
    self.skipWaiting();
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res && res.ok && new URL(req.url).origin === location.origin) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const fallback = await cache.match('index.html');
      if (fallback) return fallback;
      throw err;
    }
  })());
});
