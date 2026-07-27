import { useEffect, useState } from 'react';
import { StyleSheet, View, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import MapView, { Marker } from 'react-native-maps';
import { supabase } from '../lib/supabase';

type MapEvent = {
  id: string;
  title: string;
  location_name: string | null;
  latitude: number;
  longitude: number;
};

export default function MapScreen() {
  const router = useRouter();
  const [events, setEvents] = useState<MapEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadEvents() {
      const today = new Date().toISOString().slice(0, 10);
      const { data, error } = await supabase
        .from('events')
        .select('id, title, location_name, start_date, latitude, longitude')
        .gte('start_date', today)
        .is('duplicate_of', null)
        .not('latitude', 'is', null)
        .not('longitude', 'is', null)
        .limit(500);

      if (!error) setEvents((data ?? []) as MapEvent[]);
      setLoading(false);
    }
    loadEvents();
  }, []);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#fff" />
      </View>
    );
  }

  return (
    <MapView
      style={styles.map}
      initialRegion={{
        latitude: 48.1371,
        longitude: 11.5754,
        latitudeDelta: 0.08,
        longitudeDelta: 0.08,
      }}
    >
      {events.map((e) => (
        <Marker
          key={e.id}
          coordinate={{ latitude: e.latitude, longitude: e.longitude }}
          title={e.title}
          description={e.location_name ?? undefined}
          onCalloutPress={() => router.push(`/event/${e.id}`)}
        />
      ))}
    </MapView>
  );
}

const styles = StyleSheet.create({
  map: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' },
});