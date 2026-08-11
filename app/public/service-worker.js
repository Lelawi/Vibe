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
      icon: '/icon.png',
      badge: '/icon.png',
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

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Nur GET cachen — Supabase-Schreibzugriffe (Report-Insert etc.) sind POST
  // und sollen nie aus dem Cache beantwortet werden.
  if (request.method !== 'GET') return;

  event.respondWith(
    // { cache: 'no-store' } zwingt fetch() hier, die reguläre HTTP-Cache-
    // Ebene des Browsers zu ignorieren und wirklich das Netzwerk zu fragen.
    // Ohne das war "network-first" nicht verlässlich network-first: ein
    // plain fetch(request) darf laut Spec ganz legal aus dem normalen
    // Browser-HTTP-Cache beantwortet werden, wenn GitHub Pages' Cache-
    // Control-Header das erlauben — dann holt sich sogar dieser Service
    // Worker nur veraltete Bytes und cacht sie brav weiter, statt wirklich
    // den neuesten Deploy zu sehen (per Nutzer-Feedback wiederholt als
    // "sehe die Änderung nicht" aufgefallen, obwohl der Deploy längst
    // erfolgreich durchgelaufen war).
    fetch(request, { cache: 'no-store' })
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || Promise.reject('offline, nicht im Cache')))
  );
});
