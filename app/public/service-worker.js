// Einfacher, dependency-freier Offline-Cache für die PWA (kein Workbox o.ä.,
// passend zum sonst schlanken Ansatz dieses Projekts). Strategie: network-
// first mit Cache-Fallback für alles inkl. der Supabase-Event-Abfragen — wer
// die App schon einmal online geöffnet hat, sieht bei fehlender Verbindung
// den zuletzt geladenen Stand statt eines leeren/kaputten Screens. Kein
// Precaching fester Dateinamen nötig, da die Web-Bundles pro Build
// content-gehashte Namen haben (würden bei jedem Deploy ins Leere laufen) —
// stattdessen wird beim ersten erfolgreichen Abruf einer Datei automatisch
// gecacht.
// v2 (2026-09-30): v1 cachte JEDE GET-Anfrage ohne Obergrenze — Supabase-
// Antworten (URL enthält das Tagesdatum, täglich ~5 MB neu), fremde Bilder
// (opaque, von Chrome mit ~7 MB pro Eintrag aufs Kontingent angerechnet) und
// Kartenkacheln, dazu Fehlerantworten. Der Namenswechsel löscht diesen
// Altbestand beim nächsten activate.
const CACHE_NAME = 'vibe-cache-v2';
const API_CACHE_NAME = 'vibe-api-v2';
const API_CACHE_MAX_ENTRIES = 60;

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME && key !== API_CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

// Push-Payload kommt als JSON { title, body, url } vom Notifications-Sender
// (collectors/notifications), url bereits mit dem GitHub-Pages-Unterordner
// (/Vibe) präfixiert. url wird beim Klick geöffnet bzw. ein bereits offener
// Tab dorthin fokussiert, statt immer einen neuen Tab aufzumachen. Der
// Default hier (falls ein Payload doch mal ohne url ankommt) braucht
// denselben Präfix, sonst landet auch dieser Fallback root-relativ auf der
// GitHub-Pages-404-Seite statt in der App (siehe collectors/notifications/
// index.ts, APP_BASE_PATH).
self.addEventListener('push', (event) => {
  let payload = { title: 'Vibe', body: 'Es gibt etwas Neues für dich.', url: '/Vibe/' };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch (err) {
    // kein valides JSON — Default-Payload beibehalten
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      // Mit GitHub-Pages-Unterordner, sonst 404 und Benachrichtigung ohne Icon.
      icon: '/Vibe/icon.png',
      badge: '/Vibe/icon.png',
      data: { url: payload.url },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/Vibe/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(targetUrl) && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});

// Hält den API-Cache klein: cache.keys() liefert in Einfügereihenfolge,
// die ältesten Einträge fliegen zuerst.
async function trimCache(cache, maxEntries) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - maxEntries; i++) await cache.delete(keys[i]);
}

function networkFirst(request, cacheName, fetchOptions, maxEntries) {
  return fetch(request, fetchOptions)
    .then((response) => {
      // Nur erfolgreiche Antworten cachen — eine 500 überschrieb sonst den
      // guten Offline-Stand.
      if (response.ok) {
        const copy = response.clone();
        caches.open(cacheName)
          .then((cache) => cache.put(request, copy).then(() => (maxEntries ? trimCache(cache, maxEntries) : undefined)))
          .catch(() => {});
      }
      return response;
    })
    .catch(() => caches.match(request).then((cached) => cached || Promise.reject('offline, nicht im Cache')));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Nur GET cachen — Supabase-Schreibzugriffe (Report-Insert etc.) sind POST
  // und sollen nie aus dem Cache beantwortet werden.
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    // App-Shell und Bundles. { cache: 'no-store' } zwingt fetch() hier, die
    // reguläre HTTP-Cache-Ebene des Browsers zu ignorieren — ohne das durfte
    // fetch() laut Spec legal aus dem Browser-Cache antworten und neue
    // Deploys blieben unsichtbar (per Nutzer-Feedback wiederholt als "sehe
    // die Änderung nicht" aufgefallen).
    event.respondWith(networkFirst(request, CACHE_NAME, { cache: 'no-store' }));
    return;
  }

  if (url.hostname.endsWith('.supabase.co') && url.pathname.startsWith('/rest/')) {
    // Offline-Fallback für Datenabfragen, begrenzt (die großen Listen hält
    // die App zusätzlich selbst in IndexedDB, siehe app/lib/largeCache.ts).
    event.respondWith(networkFirst(request, API_CACHE_NAME, undefined, API_CACHE_MAX_ENTRIES));
    return;
  }

  // Alles andere (Eventbilder, Kartenkacheln, CDN) nicht abfangen: der
  // normale Browser-HTTP-Cache mit den Cache-Headern der Server ist dafür
  // besser — und die OSM-Tile-Policy verlangt, diese Header zu respektieren.
});
