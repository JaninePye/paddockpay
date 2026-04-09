const CACHE = 'paddockpay-v5';
const STATIC = [
  '/paddockpay/',
  '/paddockpay/index.html',
  '/paddockpay/manifest.json',
  '/paddockpay/icons/icon-192.png',
  '/paddockpay/icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(async c => {
      await c.addAll(STATIC);
      // Cache supabase.js separately — don't let it block install if slow
      try { await c.add('/paddockpay/supabase.js'); } catch(_) {}
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.url.includes('supabase.co')) return; // never cache API calls
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (e.request.method === 'GET' && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
