import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View, ActivityIndicator } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { supabase } from '../lib/supabase';
import { canonicalizeVenue } from '../lib/venue';
import { getFilteredEventsForMap } from '../lib/mapFilterCache';
import MapCategorySwitcher from './MapCategorySwitcher';
import type { VenueMarker } from './LeafletMapView.web';

// Lädt die eigentliche Leaflet-Karte erst zur Laufzeit im Browser (siehe
// Kommentar in LeafletMapView.web.tsx) — verhindert einen Absturz beim
// statischen Web-Export (expo export --platform web, output: "static"),
// der Komponenten serverseitig vorrendert, wo `window`/`document` fehlen.
const LeafletMapView = lazy(() => import('./LeafletMapView.web'));

type RawEvent = {
  id: string;
  title: string;
  location_name: string | null;
  latitude: number;
  longitude: number;
  start_date: string;
  start_time: string | null;
};

const MUNICH_CENTER = { lat: 48.1371, lng: 11.5754 };

export default function MapNative() {
  const router = useRouter();
  const params = useLocalSearchParams<{ lat?: string; lng?: string }>();
  const [events, setEvents] = useState<RawEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);

  useEffect(() => {
    // Best-effort, kein Fehler-UI bei Ablehnung — der "Wo bin ich"-Punkt ist
    // eine Zusatzinfo auf der Karte, kein Blocker wie die "Nähe"-Sortierung
    // auf der Listenseite.
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => setUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => {},
      { enableHighAccuracy: false, timeout: 10000 }
    );
  }, []);

  useEffect(() => {
    async function loadEvents() {
      // Von der Listenansicht bereits gefilterte Treffer (siehe
      // mapFilterCache.ts) — vorhanden, wenn man von dort zur Karte
      // navigiert ist, dann zeigt die Karte exakt dieselbe Auswahl (Suche/
      // Kategorie/Genre/Ort/Datum/Favoriten/...) statt eines zweiten,
      // unabhängigen Filterdurchlaufs. Kein Eintrag (Direktaufruf der Karte,
      // oder Kategorie-Wechsel per MapCategorySwitcher) -> alles ungefiltert
      // laden, wie bisher.
      //
      // Ist dagegen ein konkretes Ziel (lat/lng) angefragt — z.B. der
      // "Wo"-Link auf der Event-Detailseite —, den Cache NICHT verwenden:
      // diese Navigation kommt oft von woanders als der zuletzt gefilterten
      // Liste (Favoriten, "Empfohlen für dich"-Karussell, ein Programm-Link
      // auf einer Venue-Karte, ein geteilter Link...) und das konkrete Event
      // könnte in der zwischengespeicherten gefilterten Auswahl gar nicht
      // (mehr) enthalten sein — die Karte zeigte dann zwar den richtigen
      // Kartenausschnitt, aber keinen Marker darin (per Nutzer-Feedback als
      // "der Link geht nicht" gemeldet). Ein konkretes Ziel muss immer
      // sichtbar sein, unabhängig von irgendwelchen Listenfiltern.
      const hasTarget = Boolean(params.lat && params.lng);
      const cached = hasTarget ? null : getFilteredEventsForMap();
      if (cached) {
        setEvents(cached as RawEvent[]);
        setLoading(false);
        return;
      }
      const today = new Date().toISOString().slice(0, 10);
      const { data, error } = await supabase
        .from('events')
        .select('id, title, location_name, latitude, longitude, start_date, start_time')
        .gte('start_date', today)
        .is('duplicate_of', null)
        .not('latitude', 'is', null)
        .not('longitude', 'is', null)
        .order('start_date', { ascending: true })
        .limit(2000);

      if (!error) setEvents((data ?? []) as RawEvent[]);
      setLoading(false);
    }
    loadEvents();
  }, []);

  const venues = useMemo(() => {
    const map = new Map<string, VenueMarker>();
    for (const e of events) {
      const key = `${e.latitude.toFixed(4)},${e.longitude.toFixed(4)}`;
      const existing = map.get(key);
      const name = e.location_name ?? 'Unbekannter Ort';
      const eventEntry = { id: e.id, title: e.title, start_date: e.start_date, start_time: e.start_time };
      if (existing) {
        existing.events.push(eventEntry);
        if (!existing.names.includes(name)) existing.names.push(name);
      } else {
        map.set(key, { key, names: [name], latitude: e.latitude, longitude: e.longitude, events: [eventEntry] });
      }
    }
    return Array.from(map.values());
  }, [events]);

  const hasTarget = Boolean(params.lat && params.lng);
  const centerLat = hasTarget ? parseFloat(params.lat!) : MUNICH_CENTER.lat;
  const centerLng = hasTarget ? parseFloat(params.lng!) : MUNICH_CENTER.lng;
  const targetKey = hasTarget ? `${centerLat.toFixed(4)},${centerLng.toFixed(4)}` : null;

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#fff" />
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <Suspense
        fallback={
          <View style={styles.center}>
            <ActivityIndicator size="large" color="#fff" />
          </View>
        }
      >
        <LeafletMapView
          venues={venues}
          centerLat={centerLat}
          centerLng={centerLng}
          zoom={hasTarget ? 16 : 13}
          targetKey={targetKey}
          userLocation={userLocation}
          onOpenEvent={(id) => router.push(`/event/${id}`)}
          onOpenList={(names) => {
            // Die Ortsfilter auf der Startseite matchen gegen canonicalizeVenue(location_name),
            // nicht gegen die rohen, hier fürs Popup genutzten Namen ("Backstage Halle" vs.
            // "Backstage") — sonst kommt "Keine Events gefunden" trotz gültiger Auswahl raus.
            const canonical = Array.from(new Set(names.map((n) => canonicalizeVenue(n))));
            router.push({ pathname: '/', params: { locations: canonical.join(',') } });
          }}
        />
      </Suspense>
      <MapCategorySwitcher active="events" />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' },
});
