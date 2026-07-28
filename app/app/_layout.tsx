import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

export default function Layout() {
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
        <Stack.Screen name="index" options={{ title: 'Vibe' }} />
        {/* Eigener "‹ Übersicht"-Button im Screen selbst übernimmt die
            Rücknavigation (funktioniert auch bei direkt geöffneten Share-
            Links ohne Navigations-Historie) — der native Header-Pfeil würde
            bei normaler Navigation nur doppelt und verwirrend danebenstehen. */}
        <Stack.Screen name="event/[id]" options={{ title: 'Event', headerShown: false }} />
        <Stack.Screen name="map" options={{ title: 'Karte' }} />
      </Stack>
    </>
  );
}