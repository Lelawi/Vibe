import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View, ActivityIndicator, Text, TouchableOpacity } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { isOpenNow } from '../lib/openingHours';
import type { BarMarker } from './BarsLeafletView.web';

// Lädt die eigentliche Leaflet-Karte erst zur Laufzeit im Browser — gleicher
// Grund wie bei MapNative.web.tsx: Leaflet greift beim Modul-Import direkt
// auf window/document zu und würde den statischen Web-Export-Prerender
// (expo export --platform web) zum Absturz bringen.
const BarsLeafletView = lazy(() => import('./BarsLeafletView.web'));

type RawBar = {
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

export default function BarsMapNative() {
  const params = useLocalSearchParams<{ id?: string; lat?: string; lng?: string }>();
  const [bars, setBars] = useState<RawBar[]>([]);
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
    async function loadBars() {
      const [barsRes, reportsRes] = await Promise.all([
        supabase
          .from('bars')
          .select('id,name,address,latitude,longitude,opening_hours_raw,opening_hours_override,website,image_url')
          .not('latitude', 'is', null)
          .not('longitude', 'is', null),
        // Nur bestätigt geschlossene Bars von der Karte nehmen — "pending"
        // (gemeldet, aber noch nicht geprüft) bleibt sichtbar, siehe bars.tsx.
        supabase.from('bar_closure_reports').select('bar_id,status').eq('status', 'confirmed'),
      ]);
      if (!barsRes.error) setBars((barsRes.data ?? []) as RawBar[]);
      setClosedIds(new Set((reportsRes.data ?? []).map((r) => r.bar_id as string)));
      setLoading(false);
    }
    loadBars();
  }, []);

  const markers: BarMarker[] = useMemo(
    () =>
      bars
        .filter((b) => !closedIds.has(b.id))
        .map((b) => {
          // Vom Betreiber gepflegte Öffnungszeiten (Website) sind
          // zuverlässiger als der oft ungenaue/veraltete OSM-Tag.
          const effectiveHours = b.opening_hours_override ?? b.opening_hours_raw;
          return {
            id: b.id,
            name: b.name,
            address: b.address,
            latitude: b.latitude!,
            longitude: b.longitude!,
            opening_hours_raw: effectiveHours,
            open: isOpenNow(effectiveHours),
            website: b.website,
            image_url: b.image_url,
          };
        }),
    [bars, closedIds]
  );

  const targetLat = params.lat ? parseFloat(params.lat) : null;
  const targetLng = params.lng ? parseFloat(params.lng) : null;
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
        <BarsLeafletView
          bars={visibleMarkers}
          centerLat={hasTarget ? targetLat! : userLocation?.lat ?? MUNICH_CENTER.lat}
          centerLng={hasTarget ? targetLng! : userLocation?.lng ?? MUNICH_CENTER.lng}
          zoom={hasTarget ? 16 : userLocation ? 15 : 13}
          userLocation={userLocation}
          targetId={hasTarget ? params.id ?? null : null}
        />
      </Suspense>
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
    zIndex: 1000,
  },
  filterButtonActive: { backgroundColor: '#4ade80' },
  filterButtonText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  filterButtonTextActive: { color: '#000' },
});
