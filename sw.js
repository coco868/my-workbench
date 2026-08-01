const CACHE = 'workbench-v6';
const ASSETS = [
  './', './index.html', './style.css', './app.js', './supabase.min.js',
  './manifest.json', './icon-192.png', './icon-512.png', './apple-touch-icon.png'
];
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => Promise.all(ASSETS.map(u => c.add(u).catch(() => {}))))
  );
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).catch(() => caches.match('./index.html')))
  );
});
