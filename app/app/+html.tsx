import { ScrollViewStyleReset } from 'expo-router/html';
import type { PropsWithChildren } from 'react';

// Root-HTML-Dokument für den Web-Export (Expo Router). Wird nur beim
// statischen Web-Build genutzt, nicht in der nativen App. Enthält die
// PWA-Manifest-Verknüpfung + iOS-Safari-spezifische Meta-Tags, da iOS das
// Web-App-Manifest teilweise ignoriert und eigene "apple-mobile-web-app"-Tags
// für den Vollbildmodus nach "Zum Home-Bildschirm hinzufügen" braucht.
export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="de">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, shrink-to-fit=no, viewport-fit=cover"
        />
        <meta name="theme-color" content="#000000" />

        {/* Absolute Pfade mit /Vibe-Präfix, da GitHub Pages dieses Repo unter
            https://lelawi.github.io/Vibe/ ausliefert, nicht am Domain-Root
            (muss zu experiments.baseUrl in app.json passen). */}
        <link rel="manifest" href="/Vibe/manifest.json" />
        <link rel="apple-touch-icon" href="/Vibe/icon.png" />

        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Vibe" />

        <link
          rel="stylesheet"
          href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
          crossOrigin=""
        />
        {/* Marker-Clustering (Events- und Venues-Karte, siehe
            react-leaflet-cluster) — nur die Basis-CSS für Spiderfy-Animation
            und Cluster-Layout wird gebraucht, die Default-Theme-Kreise werden
            per iconCreateFunction durch eigene App-Icons ersetzt. */}
        <link
          rel="stylesheet"
          href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css"
          crossOrigin=""
        />
        <link
          rel="stylesheet"
          href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css"
          crossOrigin=""
        />

        {/* Verhindert weißes Aufblitzen/Bounce-Scrolling beim initialen Laden,
            Standard-Snippet aus der Expo-Router-Doku für +html.tsx */}
        <ScrollViewStyleReset />
      </head>
      <body style={{ backgroundColor: '#000' }}>{children}</body>
    </html>
  );
}
