// Einfacher, dependency-freier Offline-Cache für die PWA (kein Workbox o.ä.,
// passend zum sonst schlanken Ansatz dieses Projekts). Strategie: network-
// first mit Cache-Fallback für alles inkl. der Supabase-Event-Abfragen — wer
// die App schon einmal online geöffnet hat, sieht bei fehlender Verbindung
// den zuletzt geladenen Stand statt eines leeren/kaputten Screens. Kein
// Precaching fester Dateinamen nötig, da die Web-Bundles pro Build
// content-gehashte Namen haben (würden bei jedem Deploy ins Leere laufen) —
// stattdessen wird beim ersten erfolgreichen Abruf einer Datei automatisch
// gecacht.
const CACHE_NAME = 'vibe-cache-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Nur GET cachen — Supabase-Schreibzugriffe (Report-Insert etc.) sind POST
  // und sollen nie aus dem Cache beantwortet werden.
  if (request.method !== 'GET') return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || Promise.reject('offline, nicht im Cache')))
  );
});
