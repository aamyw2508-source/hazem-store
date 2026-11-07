// حازم ستور: lets the store install as an app on phones.
// Pages always come fresh from the network; a saved copy of the home page shows only when the phone is offline.
const SHELL = 'hz-shell-v1';
self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(['./', 'icon-192.png'])).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET' || r.mode !== 'navigate') return; // everything else goes straight to the network
  e.respondWith(fetch(r).then(res => {
    if (res.ok && new URL(r.url).pathname === '/') { const copy = res.clone(); caches.open(SHELL).then(c => c.put('./', copy)).catch(() => {}); }
    return res;
  }).catch(() => caches.match('./').then(m => m || Response.error())));
});
