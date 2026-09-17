// ============================================================
// SBR Budget — Service Worker minimal
// Met en cache l'app shell pour l'installation PWA. Ne met jamais
// en cache les appels /api/ ou /auth/ (données bancaires sensibles).
// ============================================================

const CACHE_NAME = 'sbr-budget-shell-v1';
const APP_SHELL = ['/', '/styles.css', '/app.js', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Jamais de cache pour les routes API ou d'authentification.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
