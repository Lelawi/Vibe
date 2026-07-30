import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View, ActivityIndicator, Text, Linking, Pressable, TouchableOpacity } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import MapView, { Marker, Callout, Region } from 'react-native-maps';
import { supabase } from '../lib/supabase';
import { isOpenNow, todayLabel } from '../lib/openingHours';

type Bar = {
  id: string;
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  opening_hours_raw: string | null;
  website: string | null;
};

// Nur der Bar-Name reicht bei generischen OSM-Namen nicht als Suchbegriff —
// z.B. ist eine Bar in OSM schlicht als "Bridge" statt "Bridge Bar" gepflegt,
// eine reine Namenssuche auf Google Maps interpretiert das dann als
// Freitextsuche und findet echte Brücken statt der Bar. Mit Adresse ist die
// Anfrage eindeutig; ganz ohne Adresse lieber auf die exakten Koordinaten
// zurückfallen statt auf den (ggf. mehrdeutigen) nackten Namen.
function openInGoogleMaps(lat: number, lng: number, name: string, address?: string | null) {
  const query = address ? `${name}, ${address}` : null;
  const url = query
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`
    : `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  Linking.openURL(url);
}

// Grün/Rot/Grau statt des App-Blaus (#0af) — das ist bereits "meine
// Position" (der native blaue Standort-Punkt von showsUserLocation), zwei
// blaue Elemente auf derselben Karte waren kaum zu unterscheiden. Kodiert
// zusätzlich den Öffnungsstatus direkt auf der Karte.
function pinColor(open: boolean | null): string {
  return open === true ? '#4ade80' : open === false ? '#ff6b6b' : '#999';
}

export default function BarsMapNative() {
  const params = useLocalSearchParams<{ id?: string; lat?: string; lng?: string }>();
  const [bars, setBars] = useState<Bar[]>([]);
  const [closedIds, setClosedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [onlyOpen, setOnlyOpen] = useState(false);
  const markerRefs = useRef<Map<string, any>>(new Map());

  useEffect(() => {
    async function loadBars() {
      const [barsRes, reportsRes] = await Promise.all([
        supabase
          .from('bars')
          .select('id,name,address,latitude,longitude,opening_hours_raw,website')
          .not('latitude', 'is', null)
          .not('longitude', 'is', null),
        supabase.from('bar_closure_reports').select('bar_id'),
      ]);
      if (!barsRes.error) setBars((barsRes.data ?? []) as Bar[]);
      setClosedIds(new Set((reportsRes.data ?? []).map((r) => r.bar_id as string)));
      setLoading(false);
    }
    loadBars();
  }, []);

  const markers = useMemo(
    () =>
      bars
        .filter((b) => !closedIds.has(b.id))
        .map((b) => ({ ...b, open: isOpenNow(b.opening_hours_raw), hoursToday: todayLabel(b.opening_hours_raw) })),
    [bars, closedIds]
  );

  const visibleMarkers = useMemo(
    () => (onlyOpen ? markers.filter((m) => m.open === true) : markers),
    [markers, onlyOpen]
  );

  const initialRegion: Region =
    params.lat && params.lng
      ? { latitude: parseFloat(params.lat), longitude: parseFloat(params.lng), latitudeDelta: 0.02, longitudeDelta: 0.02 }
      : { latitude: 48.1371, longitude: 11.5754, latitudeDelta: 0.08, longitudeDelta: 0.08 };

  useEffect(() => {
    if (!params.id) return;
    const timeout = setTimeout(() => {
      markerRefs.current.get(params.id!)?.showCallout();
    }, 400);
    return () => clearTimeout(timeout);
  }, [params.id, markers]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#fff" />
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <MapView style={styles.map} initialRegion={initialRegion} showsUserLocation showsMyLocationButton>
        {visibleMarkers.map((bar) => (
          <Marker
            key={bar.id}
            ref={(ref) => {
              if (ref) markerRefs.current.set(bar.id, ref);
            }}
            coordinate={{ latitude: bar.latitude!, longitude: bar.longitude! }}
            pinColor={pinColor(bar.open)}
          >
            <Callout tooltip={false}>
              <View style={styles.callout}>
                <View style={styles.calloutHeaderRow}>
                  <Text style={styles.calloutTitle}>{bar.name}</Text>
                  {bar.open === true && <Text style={styles.openBadge}>Geöffnet</Text>}
                  {bar.open === false && <Text style={styles.closedBadge}>Geschlossen</Text>}
                </View>
                {bar.address && <Text style={styles.calloutAddress}>{bar.address}</Text>}
                {bar.hoursToday && <Text style={styles.calloutHours}>Heute: {bar.hoursToday}</Text>}
                {bar.website && (
                  <Pressable onPress={() => Linking.openURL(bar.website!)}>
                    <Text style={styles.calloutLink}>Website öffnen</Text>
                  </Pressable>
                )}
                <Pressable onPress={() => openInGoogleMaps(bar.latitude!, bar.longitude!, bar.name, bar.address)}>
                  <Text style={styles.calloutLink}>In Google Maps öffnen</Text>
                </Pressable>
              </View>
            </Callout>
          </Marker>
        ))}
      </MapView>
      <TouchableOpacity
        style={[styles.filterButton, onlyOpen && styles.filterButtonActive]}
        onPress={() => setOnlyOpen((v) => !v)}
      >
        <Ionicons name="time-outline" size={15} color={onlyOpen ? '#000' : '#fff'} />
        <Text style={[styles.filterButtonText, onlyOpen && styles.filterButtonTextActive]}>
          Jetzt geöffnet ({markers.filter((m) => m.open === true).length})
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  map: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' },
  callout: { minWidth: 200, padding: 4 },
  calloutHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  calloutTitle: { fontWeight: '700', fontSize: 14 },
  openBadge: { fontSize: 10, fontWeight: '700', color: '#1a7a3d', backgroundColor: '#4ade8033', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  closedBadge: { fontSize: 10, fontWeight: '700', color: '#b3261e', backgroundColor: '#ff6b6b33', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  calloutAddress: { fontSize: 12, color: '#444' },
  calloutHours: { fontSize: 12, color: '#444', marginTop: 2 },
  calloutLink: { fontSize: 12, color: '#0af', fontWeight: '600', marginTop: 4 },
  filterButton: {
    position: 'absolute',
    top: 12,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(20,20,20,0.92)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  filterButtonActive: { backgroundColor: '#4ade80' },
  filterButtonText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  filterButtonTextActive: { color: '#000' },
});
