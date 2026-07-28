import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View, ActivityIndicator } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { supabase } from '../lib/supabase';
import type { VenueMarker } from './LeafletMapView.web';

// Lädt die eigentliche Leaflet-Karte erst zur Laufzeit im Browser (siehe
// Kommentar in LeafletMapView.web.tsx) — verhindert einen Absturz beim
// statischen Web-Export (expo export --platform web, output: "static"),
// der Komponenten serverseitig vorrendert, wo `window`/`document` fehlen.
const LeafletMapView = lazy(() => import('./LeafletMapView.web'));

type RawEvent = {
  id: string;
  location_name: string | null;
  latitude: number;
  longitude: number;
};

const MUNICH_CENTER = { lat: 48.1371, lng: 11.5754 };

export default function MapNative() {
  const router = useRouter();
  const params = useLocalSearchParams<{ lat?: string; lng?: string }>();
  const [events, setEvents] = useState<RawEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadEvents() {
      const today = new Date().toISOString().slice(0, 10);
      const { data, error } = await supabase
        .from('events')
        .select('id, location_name, latitude, longitude')
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
      if (existing) {
        existing.count += 1;
        if (!existing.names.includes(name)) existing.names.push(name);
      } else {
        map.set(key, { key, names: [name], latitude: e.latitude, longitude: e.longitude, count: 1 });
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
        onOpenList={(names) => router.push({ pathname: '/', params: { locations: names.join(',') } })}
      />
    </Suspense>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' },
});
