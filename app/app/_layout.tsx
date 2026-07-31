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