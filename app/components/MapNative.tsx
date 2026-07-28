import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View, ActivityIndicator, Text, Linking } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import MapView, { Marker, Callout, CalloutSubview, Region } from 'react-native-maps';
import { supabase } from '../lib/supabase';

type RawEvent = {
  id: string;
  location_name: string | null;
  latitude: number;
  longitude: number;
};

type VenueMarker = {
  key: string;
  names: string[];
  latitude: number;
  longitude: number;
  count: number;
};

function venueTitle(names: string[]) {
  if (names.length === 1) return names[0];
  if (names.length <= 3) return names.join(' / ');
  return `${names[0]} + ${names.length - 1} weitere`;
}

function openInGoogleMaps(lat: number, lng: number, label: string) {
  const query = `${lat},${lng}(${encodeURIComponent(label)})`;
  const url = `https://www.google.com/maps/search/?api=1&query=${query}`;
  console.log('Google Maps URL:', url);
  Linking.openURL(url);
}

export default function MapNative() {
  const router = useRouter();
  const params = useLocalSearchParams<{ lat?: string; lng?: string }>();
  const [events, setEvents] = useState<RawEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const markerRefs = useRef<Map<string, any>>(new Map());

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
        map.set(key, {
          key,
          names: [name],
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

  useEffect(() => {
    if (!params.lat || !params.lng || venues.length === 0) return;
    const targetKey = `${parseFloat(params.lat).toFixed(4)},${parseFloat(params.lng).toFixed(4)}`;
    const timeout = setTimeout(() => {
      markerRefs.current.get(targetKey)?.showCallout();
    }, 400);
    return () => clearTimeout(timeout);
  }, [params.lat, params.lng, venues]);

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
          ref={(ref) => {
            if (ref) markerRefs.current.set(v.key, ref);
          }}
          coordinate={{ latitude: v.latitude, longitude: v.longitude }}
        >
          <Callout tooltip={false}>
            <View style={styles.callout}>
              <CalloutSubview
                onPress={() =>
                  router.push({ pathname: '/', params: { locations: v.names.join(',') } })
                }
              >
                <View style={styles.calloutTextArea}>
                  <Text style={styles.calloutTitle}>{venueTitle(v.names)}</Text>
                  <Text style={styles.calloutSubtitle}>
                    {v.count} Event{v.count === 1 ? '' : 's'} · Liste öffnen
                  </Text>
                </View>
              </CalloutSubview>
              <CalloutSubview
                onPress={() => openInGoogleMaps(v.latitude, v.longitude, v.names[0])}
              >
                <View style={styles.calloutMapsButton}>
                  <Text style={styles.calloutMapsButtonText}>In Google Maps öffnen</Text>
                </View>
              </CalloutSubview>
            </View>
          </Callout>
        </Marker>
      ))}
    </MapView>
  );
}

const styles = StyleSheet.create({
  map: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' },
  callout: { minWidth: 180, padding: 4 },
  calloutTextArea: { marginBottom: 8 },
  calloutTitle: { fontWeight: '700', fontSize: 14, marginBottom: 2 },
  calloutSubtitle: { fontSize: 12, color: '#666' },
  calloutMapsButton: {
    backgroundColor: '#0af',
    borderRadius: 8,
    paddingVertical: 6,
    alignItems: 'center',
  },
  calloutMapsButtonText: { color: '#000', fontWeight: '700', fontSize: 12 },
});