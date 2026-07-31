import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View, ActivityIndicator, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { isOpenNow } from '../lib/openingHours';
import { fetchAllVenues } from '../lib/fetchAllVenues';
import { getFilteredVenuesForMap } from '../lib/mapFilterCache';
import MapCategorySwitcher from './MapCategorySwitcher';
import type { VenueMarker } from './VenueLeafletView.web';
import type { VenueType } from './VenueListScreen';

// Lädt die eigentliche Leaflet-Karte erst zur Laufzeit im Browser — gleicher
// Grund wie bei MapNative.web.tsx: Leaflet greift beim Modul-Import direkt
// auf window/document zu und würde den statischen Web-Export-Prerender
// (expo export --platform web) zum Absturz bringen.
const VenueLeafletView = lazy(() => import('./VenueLeafletView.web'));

type RawVenue = {
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

const MUNICH_CENTER = { lat: 48.1371, lng: 11.5754 };

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
  const [venues, setVenues] = useState<RawVenue[]>([]);
  // Von der Listenansicht bereits gefilterte Treffer (siehe mapFilterCache.ts)
  // — vorhanden, wenn man von dort zur Karte navigiert ist, dann zeigt die
  // Karte exakt dieselbe Auswahl statt eines zweiten, unabhängigen
  // Filterdurchlaufs. null = kein Filterkontext, unten wird stattdessen
  // ungefiltert geladen (Direktaufruf der Karte oder Kategorie-Wechsel per
  // MapCategorySwitcher, ohne vorherigen Listenbesuch für diesen Typ).
  const [cachedMarkers, setCachedMarkers] = useState<VenueMarker[] | null>(null);
  const [closedIds, setClosedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [onlyOpen, setOnlyOpen] = useState(false);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => setUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => {},
      { enableHighAccuracy: false, timeout: 10000 }
    );
  }, []);

  useEffect(() => {
    async function load() {
      const cached = getFilteredVenuesForMap(type);
      if (cached) {
        setCachedMarkers(cached);
        setLoading(false);
        return;
      }
      setCachedMarkers(null);
      // Supabase deckelt eine einzelne Abfrage hart bei 1000 Zeilen — bei
      // 2263 Restaurants hätte ein einfaches .select() über die Hälfte
      // verschluckt (siehe app/lib/fetchAllVenues.ts).
      const [venuesData, reportsRes] = await Promise.all([
        fetchAllVenues<RawVenue>(
          type,
          'id,name,address,latitude,longitude,opening_hours_raw,opening_hours_override,website,image_url'
        ),
        // Nur bestätigt geschlossene Einträge von der Karte nehmen — "pending"
        // (gemeldet, aber noch nicht geprüft) bleibt sichtbar, siehe VenueListScreen.
        supabase.from('venue_closure_reports').select('venue_id,status').eq('status', 'confirmed'),
      ]);
      setVenues(venuesData.filter((v) => v.latitude != null && v.longitude != null));
      setClosedIds(new Set((reportsRes.data ?? []).map((r) => r.venue_id as string)));
      setLoading(false);
    }
    load();
  }, [type]);

  const markers: VenueMarker[] = useMemo(() => {
    if (cachedMarkers) return cachedMarkers;
    return venues
      .filter((v) => !closedIds.has(v.id))
      .map((v) => {
        // Vom Betreiber gepflegte Öffnungszeiten (Website) sind
        // zuverlässiger als der oft ungenaue/veraltete OSM-Tag.
        const effectiveHours = v.opening_hours_override ?? v.opening_hours_raw;
        return {
          id: v.id,
          name: v.name,
          address: v.address,
          latitude: v.latitude!,
          longitude: v.longitude!,
          opening_hours_raw: effectiveHours,
          open: isOpenNow(effectiveHours),
          website: v.website,
          image_url: v.image_url,
        };
      });
  }, [cachedMarkers, venues, closedIds]);

  const hasTarget = targetLat != null && targetLng != null && !Number.isNaN(targetLat) && !Number.isNaN(targetLng);

  // "Jetzt geöffnet"-Filter erst nach dem Öffnungsstatus-Mapping anwenden,
  // nicht schon in der Supabase-Abfrage — der Status hängt vom aktuellen
  // Zeitpunkt ab und wird clientseitig aus opening_hours_raw berechnet.
  const visibleMarkers = useMemo(
    () => (onlyOpen ? markers.filter((m) => m.open === true) : markers),
    [markers, onlyOpen]
  );

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
        <VenueLeafletView
          venues={visibleMarkers}
          centerLat={hasTarget ? targetLat! : userLocation?.lat ?? MUNICH_CENTER.lat}
          centerLng={hasTarget ? targetLng! : userLocation?.lng ?? MUNICH_CENTER.lng}
          zoom={hasTarget ? 16 : userLocation ? 15 : 13}
          userLocation={userLocation}
          targetId={hasTarget ? targetId ?? null : null}
        />
      </Suspense>
      <MapCategorySwitcher active={type === 'bar' ? 'bars' : 'restaurants'} />
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
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' },
  filterButton: {
    position: 'absolute',
    top: 60,
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
    zIndex: 1000,
  },
  filterButtonActive: { backgroundColor: '#4ade80' },
  filterButtonText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  filterButtonTextActive: { color: '#000' },
});
