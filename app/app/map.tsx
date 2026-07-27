import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View, ActivityIndicator } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import MapView, { Marker, Region } from 'react-native-maps';
import { supabase } from '../lib/supabase';

type RawEvent = {
  id: string;
  location_name: string | null;
  latitude: number;
  longitude: number;
};

type VenueMarker = {
  key: string;
  name: string;
  latitude: number;
  longitude: number;
  count: number;
};

export default function MapScreen() {
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

  // Events zu eindeutigen Orten zusammenfassen - ein Pin pro Ort statt pro Event
  const venues = useMemo(() => {
    const map = new Map<string, VenueMarker>();
    for (const e of events) {
      const key = `${e.latitude.toFixed(4)},${e.longitude.toFixed(4)}`;
      const existing = map.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        map.set(key, {
          key,
          name: e.location_name ?? 'Unbekannter Ort',
          latitude: e.latitude,
          longitude: e.longitude,
          count: 1,
        });
      }
    }
    return Array.from(map.values());
  }, [events]);

  const initialRegion: Region =
    params.lat && params.lng
      ? {
          latitude: parseFloat(params.lat),
          longitude: parseFloat(params.lng),
          latitudeDelta: 0.02,
          longitudeDelta: 0.02,
        }
      : {
          latitude: 48.1371,
          longitude: 11.5754,
          latitudeDelta: 0.08,
          longitudeDelta: 0.08,
        };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#fff" />
      </View>
    );
  }

  return (
    <MapView style={styles.map} initialRegion={initialRegion}>
      {venues.map((v) => (
        <Marker
          key={v.key}
          coordinate={{ latitude: v.latitude, longitude: v.longitude }}
          title={v.name}
          description={`${v.count} Event${v.count === 1 ? '' : 's'}`}
          onCalloutPress={() =>
            router.push({ pathname: '/', params: { location: v.name } })
          }
        />
      ))}
    </MapView>
  );
}

const styles = StyleSheet.create({
  map: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' },
});