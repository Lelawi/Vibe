import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View, ActivityIndicator, Text, Linking } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import MapView, { Marker, Callout, CalloutSubview, Region } from 'react-native-maps';
import { supabase } from '../lib/supabase';
import { canonicalizeVenue } from '../lib/venue';

type RawEvent = {
  id: string;
  title: string;
  location_name: string | null;
  latitude: number;
  longitude: number;
  start_date: string;
  start_time: string | null;
};

type VenueEvent = {
  id: string;
  title: string;
  start_date: string;
  start_time: string | null;
};

type VenueMarker = {
  key: string;
  names: string[];
  latitude: number;
  longitude: number;
  events: VenueEvent[];
};

const MAX_CALLOUT_EVENTS = 4;

function venueTitle(names: string[]) {
  if (names.length === 1) return names[0];
  if (names.length <= 3) return names.join(' / ');
  return `${names[0]} + ${names.length - 1} weitere`;
}

function formatShort(dateStr: string, timeStr: string | null) {
  const date = new Date(`${dateStr}T${timeStr ?? '00:00'}`);
  const formatted = date.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: 'short' });
  return timeStr ? `${formatted} · ${timeStr.slice(0, 5)}` : formatted;
}

function openInGoogleMaps(lat: number, lng: number, label?: string) {
  const query = label?.trim();
  const url = query
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`
    : `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
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
        map.set(key, {
          key,
          names: [name],
          latitude: e.latitude,
          longitude: e.longitude,
          events: [eventEntry],
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
    <MapView style={styles.map} initialRegion={initialRegion} showsUserLocation showsMyLocationButton>
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
              <Text style={styles.calloutTitle}>{venueTitle(v.names)}</Text>
              {v.events.slice(0, MAX_CALLOUT_EVENTS).map((ev) => (
                <CalloutSubview key={ev.id} onPress={() => router.push(`/event/${ev.id}`)}>
                  <View style={styles.calloutEventRow}>
                    <Text style={styles.calloutEventTitle} numberOfLines={1}>{ev.title}</Text>
                    <Text style={styles.calloutEventDate}>{formatShort(ev.start_date, ev.start_time)}</Text>
                  </View>
                </CalloutSubview>
              ))}
              {v.events.length > MAX_CALLOUT_EVENTS && (
                <CalloutSubview
                  onPress={() => {
                    const canonical = Array.from(new Set(v.names.map((n) => canonicalizeVenue(n))));
                    router.push({ pathname: '/', params: { locations: canonical.join(',') } });
                  }}
                >
                  <Text style={styles.calloutSubtitle}>
                    + {v.events.length - MAX_CALLOUT_EVENTS} weitere · Liste öffnen
                  </Text>
                </CalloutSubview>
              )}
              <CalloutSubview
                onPress={() => openInGoogleMaps(v.latitude, v.longitude, venueTitle(v.names))}
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
  callout: { minWidth: 200, padding: 4 },
  calloutTitle: { fontWeight: '700', fontSize: 14, marginBottom: 6 },
  calloutEventRow: { marginBottom: 6 },
  calloutEventTitle: { fontSize: 13, fontWeight: '600', color: '#111' },
  calloutEventDate: { fontSize: 11, color: '#666', marginTop: 1 },
  calloutSubtitle: { fontSize: 12, color: '#0af', fontWeight: '600', marginBottom: 8 },
  calloutMapsButton: {
    backgroundColor: '#0af',
    borderRadius: 8,
    paddingVertical: 6,
    alignItems: 'center',
    marginTop: 4,
  },
  calloutMapsButtonText: { color: '#000', fontWeight: '700', fontSize: 12 },
});