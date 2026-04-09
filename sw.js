const CACHE = 'paddockpay-v3';
const STATIC = [
  '/paddockpay/',
  '/paddockpay/index.html',
  '/paddockpay/manifest.json',
  '/paddockpay/icons/icon-192.png',
  '/paddockpay/icons/icon-512.png'
];
// supabase.js is large (187KB) — cached opportunistically on first fetch, not at install time

// Install: cache static assets
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC))
  );
  self.skipWaiting();
});

// Activate: delete old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: network first, cache fallback for static; never cache API calls
self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Never cache Supabase API or external CDN requests
  if (
    url.includes('supabase.co') ||
    url.includes('googleapis.com') ||
    url.includes('gstatic.com') ||
    url.includes('jsdelivr.net')
  ) {
    return; // Let browser handle normally
  }

  e.respondWith(
    fetch(e.request)
      .then(response => {
        // Cache successful GET responses
        if (e.request.method === 'GET' && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(e.request))
  );
});
