import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View, ActivityIndicator, Text, Linking, Pressable, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import MapView, { Marker, Callout, Region } from 'react-native-maps';
import { supabase } from '../lib/supabase';
import { isOpenNow, todayLabel } from '../lib/openingHours';
import type { VenueType } from './VenueListScreen';

type Venue = {
  id: string;
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  opening_hours_raw: string | null;
  opening_hours_override: string | null;
  website: string | null;
  image_url: string | null;
};

// Nur der Name reicht bei generischen OSM-Namen nicht als Suchbegriff — z.B.
// ist eine Bar in OSM schlicht als "Bridge" statt "Bridge Bar" gepflegt, eine
// reine Namenssuche auf Google Maps interpretiert das dann als Freitextsuche
// und findet echte Brücken statt der Bar. Mit Adresse ist die Anfrage
// eindeutig; ganz ohne Adresse lieber auf die exakten Koordinaten
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

export default function VenueMapNative({
  type,
  targetId,
  targetLat,
  targetLng,
}: {
  type: VenueType;
  targetId?: string | null;
  targetLat?: number | null;
  targetLng?: number | null;
}) {
  const [venues, setVenues] = useState<Venue[]>([]);
  const [confirmedClosedIds, setConfirmedClosedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [onlyOpen, setOnlyOpen] = useState(false);
  const markerRefs = useRef<Map<string, any>>(new Map());

  useEffect(() => {
    async function load() {
      const [venuesRes, reportsRes] = await Promise.all([
        supabase
          .from('venues')
          .select('id,name,address,latitude,longitude,opening_hours_raw,opening_hours_override,website,image_url')
          .eq('type', type)
          .not('latitude', 'is', null)
          .not('longitude', 'is', null),
        // Nur bestätigt geschlossene Einträge von der Karte nehmen — "pending"
        // (gemeldet, aber noch nicht geprüft) bleibt sichtbar, siehe VenueListScreen.
        supabase.from('venue_closure_reports').select('venue_id,status').eq('status', 'confirmed'),
      ]);
      if (!venuesRes.error) setVenues((venuesRes.data ?? []) as Venue[]);
      setConfirmedClosedIds(new Set((reportsRes.data ?? []).map((r) => r.venue_id as string)));
      setLoading(false);
    }
    load();
  }, [type]);

  const markers = useMemo(
    () =>
      venues
        .filter((v) => !confirmedClosedIds.has(v.id))
        .map((v) => {
          // Vom Betreiber gepflegte Öffnungszeiten (Website) sind
          // zuverlässiger als der oft ungenaue/veraltete OSM-Tag.
          const effectiveHours = v.opening_hours_override ?? v.opening_hours_raw;
          return { ...v, open: isOpenNow(effectiveHours), hoursToday: todayLabel(effectiveHours) };
        }),
    [venues, confirmedClosedIds]
  );

  const visibleMarkers = useMemo(
    () => (onlyOpen ? markers.filter((m) => m.open === true) : markers),
    [markers, onlyOpen]
  );

  const initialRegion: Region =
    targetLat != null && targetLng != null
      ? { latitude: targetLat, longitude: targetLng, latitudeDelta: 0.02, longitudeDelta: 0.02 }
      : { latitude: 48.1371, longitude: 11.5754, latitudeDelta: 0.08, longitudeDelta: 0.08 };

  useEffect(() => {
    if (!targetId) return;
    const timeout = setTimeout(() => {
      markerRefs.current.get(targetId)?.showCallout();
    }, 400);
    return () => clearTimeout(timeout);
  }, [targetId, markers]);

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
        {visibleMarkers.map((venue) => (
          <Marker
            key={venue.id}
            ref={(ref) => {
              if (ref) markerRefs.current.set(venue.id, ref);
            }}
            coordinate={{ latitude: venue.latitude!, longitude: venue.longitude! }}
            pinColor={pinColor(venue.open)}
          >
            <Callout tooltip={false}>
              <View style={styles.callout}>
                <View style={styles.calloutHeaderRow}>
                  <Text style={styles.calloutTitle}>{venue.name}</Text>
                  {venue.open === true && <Text style={styles.openBadge}>Geöffnet</Text>}
                  {venue.open === false && <Text style={styles.closedBadge}>Geschlossen</Text>}
                </View>
                {venue.address && <Text style={styles.calloutAddress}>{venue.address}</Text>}
                {venue.hoursToday && <Text style={styles.calloutHours}>Heute: {venue.hoursToday}</Text>}
                {venue.website && (
                  <Pressable onPress={() => Linking.openURL(venue.website!)}>
                    <Text style={styles.calloutLink}>Website öffnen</Text>
                  </Pressable>
                )}
                <Pressable onPress={() => openInGoogleMaps(venue.latitude!, venue.longitude!, venue.name, venue.address)}>
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
