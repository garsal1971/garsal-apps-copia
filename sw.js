// AppSphere Service Worker v1.0.0
const CACHE_NAME = 'appsphere-v1';

// File da pre-cachare (shell dell'app)
const PRECACHE = [
  '/app-launcher.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// ── Install: pre-cacha la shell ─────────────────────────────────────────────
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(PRECACHE);
    })
  );
  self.skipWaiting();
});

// ── Activate: rimuove cache vecchie ────────────────────────────────────────
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_NAME; })
            .map(function(k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

// ── Fetch: network-first, fallback cache ───────────────────────────────────
// Le chiamate Supabase/Google vanno sempre in rete (no cache).
self.addEventListener('fetch', function(event) {
  var url = event.request.url;

  // Lascia passare senza intercettare: Supabase, Google, CDN esterni
  if (url.includes('supabase.co') ||
      url.includes('googleapis.com') ||
      url.includes('googlefonts') ||
      url.includes('jsdelivr.net') ||
      url.includes('cdnjs.cloudflare.com')) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(function(response) {
        // Aggiorna la cache con la risposta fresca
        if (response && response.status === 200 && event.request.method === 'GET') {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(event.request, clone);
          });
        }
        return response;
      })
      .catch(function() {
        // Offline: prova dalla cache
        return caches.match(event.request).then(function(cached) {
          return cached || caches.match('/app-launcher.html');
        });
      })
  );
});
