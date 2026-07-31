import { useEffect } from 'react';
import { Platform } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

export default function Layout() {
  useEffect(() => {
    // Service Worker fürs Offline-Caching nur im Web-Build relevant — Pfad
    // mit dem GitHub-Pages-Unterordner (siehe experiments.baseUrl in
    // app.json), sonst würde die Registrierung im Root-Scope landen und ins
    // Leere laufen.
    if (Platform.OS === 'web' && typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/Vibe/service-worker.js').catch(() => {});
    }

    // Als installierte PWA (manifest.json: display "standalone") öffnet
    // Linking.openURL(...) externe Links (Ticket-Links, Websites, Google
    // Maps) über window.open(url, '_blank') — react-native-web setzt das
    // beim Web-Build so per Default. Ohne eigenes Tab-UI kann das Standalone-
    // Fenster den "neuen Tab" nicht selbst öffnen und übergibt stattdessen an
    // den System-Browser, während das Vibe-Fenster im Hintergrund
    // eingefroren hängen bleibt — ein bekannter WebKit/Chromium-Bug bei
    // Standalone-PWAs. Beim Zurückwechseln bleibt es dadurch bis zum
    // nächsten Tap leer weiß (per Nutzer-Feedback: "eine leere weiße Seite,
    // die ich erst wegklicken muss"). Ein erzwungener Reflow beim
    // Sichtbarwerden ist der gängige Workaround dafür.
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      const handleVisibilityChange = () => {
        if (document.visibilityState !== 'visible') return;
        const body = document.body;
        const previousDisplay = body.style.display;
        body.style.display = 'none';
        // Layout-Neuberechnung erzwingen, bevor display wieder hergestellt wird.
        void body.offsetHeight;
        body.style.display = previousDisplay;
      };
      document.addEventListener('visibilitychange', handleVisibilityChange);
      return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
    }
  }, []);

  return (
    <>
      {/* App ist komplett dunkel gestylt (#000-Hintergründe überall) — ohne
          "light" wäre die Statusleiste (Uhrzeit/Akku) dunkel-auf-dunkel und
          kaum lesbar. */}
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: '#000' },
          headerTintColor: '#fff',
          headerTitleStyle: { color: '#fff' },
          contentStyle: { backgroundColor: '#000' },
        }}
      >
        {/* Eigenes Gradient-Banner im Screen übernimmt den Titel — der native
            Header hätte hier sonst ein zweites, redundantes "Vibe" direkt
            über dem eigenen Banner gezeigt. */}
        <Stack.Screen name="index" options={{ title: 'Vibe', headerShown: false }} />
        {/* Eigener "‹ Übersicht"-Button im Screen selbst übernimmt die
            Rücknavigation (funktioniert auch bei direkt geöffneten Share-
            Links ohne Navigations-Historie) — der native Header-Pfeil würde
            bei normaler Navigation nur doppelt und verwirrend danebenstehen. */}
        <Stack.Screen name="event/[id]" options={{ title: 'Event', headerShown: false }} />
        <Stack.Screen name="map" options={{ title: 'Karte' }} />
        {/* Eigener "‹ Übersicht"-Button im Screen selbst, gleiches Muster wie
            bei event/[id] — kein natives Header nötig. */}
        <Stack.Screen name="bars" options={{ title: 'Bars', headerShown: false }} />
        <Stack.Screen name="bars-map" options={{ title: 'Bars-Karte' }} />
        {/* Fehlte hier komplett -> Expo Router griff auf einen ungestylten
            Default-Header mit nativem Zurück-Pfeil zurück (per Screenshot
            gemeldet), obwohl VenueListScreen bereits die BottomTabBar für
            die Navigation hat — gleiches Muster wie "bars" oben. */}
        <Stack.Screen name="restaurants" options={{ title: 'Restaurants', headerShown: false }} />
        <Stack.Screen name="restaurants-map" options={{ title: 'Restaurants-Karte' }} />
        <Stack.Screen name="spaetis" options={{ title: 'Spätis', headerShown: false }} />
        <Stack.Screen name="spaetis-map" options={{ title: 'Spätis-Karte' }} />
      </Stack>
    </>
  );
}