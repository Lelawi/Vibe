import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View, ActivityIndicator, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { isOpenNow } from '../lib/openingHours';
import { fetchAllVenues } from '../lib/fetchAllVenues';
import { getFilteredVenuesForMap } from '../lib/mapFilterCache';
import MapCategorySwitcher, { type MapCategory } from './MapCategorySwitcher';
import type { VenueMarker, VenueLeafletHandle } from './VenueLeafletView.web';
import type { VenueType } from './VenueListScreen';
import { registerStrings, useTranslation } from '../lib/strings';

registerStrings({
  'venueMap.openNow': { de: 'Jetzt geöffnet', en: 'Open now' },
  'venueMap.lunch': { de: 'Mittagslunch', en: 'Lunch menu' },
});

const MAP_CATEGORY: Record<VenueType, MapCategory> = { bar: 'bars', restaurant: 'restaurants', spaeti: 'spaetis' };

// Lädt die eigentliche Leaflet-Karte erst zur Laufzeit im Browser — gleicher
// Grund wie bei MapNative.web.tsx: Leaflet greift beim Modul-Import direkt
// auf window/document zu und würde den statischen Web-Export-Prerender
// (expo export --platform web) zum Absturz bringen.
const VenueLeafletView = lazy(() => import('./VenueLeafletView.web'));

type RawVenue = {
  id: string;
  name: string;
  name_override: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  opening_hours_raw: string | null;
  opening_hours_override: string | null;
  google_opening_hours: string | null;
  website: string | null;
  image_url: string | null;
  lunch_available: boolean | null;
  lunch_menu_url: string | null;
  dinner_menu_url: string | null;
  beer_price_eur: number | null;
  wifi: boolean | null;
  google_rating: number | null;
  google_rating_count: number | null;
  google_place_id: string | null;
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
  const { t } = useTranslation();
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
  const [lunchOnly, setLunchOnly] = useState(false);
  const leafletRef = useRef<VenueLeafletHandle>(null);

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
      // Ein konkretes Ziel (targetId/lat/lng, z.B. von einem angetippten
      // Karteneintrag) muss immer sichtbar sein, unabhängig davon, ob es in
      // der zuletzt gefilterten Listenauswahl enthalten war — sonst könnte
      // eine Navigation von woanders als der aktuell gefilterten Liste
      // (Favoriten, ein Programm-Link, ein geteilter Link...) auf der Karte
      // ins Leere laufen (siehe identischer Fix in MapNative.web.tsx).
      const hasTarget = targetLat != null && targetLng != null && !Number.isNaN(targetLat) && !Number.isNaN(targetLng);
      const cached = hasTarget ? null : getFilteredVenuesForMap(type);
      if (cached) {
        setCachedMarkers(cached);
        setLoading(false);
        return;
      }
      setCachedMarkers(null);
      // Supabase deckelt eine einzelne Abfrage hart bei 1000 Zeilen — bei
      // 2263 Restaurants hätte ein einfaches .select() über die Hälfte
      // verschluckt (siehe app/lib/fetchAllVenues.ts).
      const venuesColumns =
        'id,name,name_override,address,latitude,longitude,opening_hours_raw,opening_hours_override,google_opening_hours,google_place_id,website,image_url,lunch_available,lunch_menu_url,dinner_menu_url,beer_price_eur,wifi,google_rating,google_rating_count';
      const [venuesData, reportsRes] = await Promise.all([
        fetchAllVenues<RawVenue>(type, venuesColumns).catch(async (err) => {
          // name_override (0023)/dinner_menu_url (0021)/beer_price_eur
          // (0018)/wifi (0022)/google_rating* (0024) kamen nachträglich dazu
          // — falls eine dieser Migrationen noch nicht angewendet wurde,
          // soll die Karte trotzdem funktionieren (nur ohne die jeweilige
          // Info) statt vom Direktaufruf der Karte (ohne Listen-
          // Filterkontext, siehe getFilteredVenuesForMap oben) komplett leer
          // zu bleiben.
          console.warn('[VenueMapNative] retrying without google_opening_hours', err);
          try {
            const fallback = await fetchAllVenues<Omit<RawVenue, 'google_opening_hours'>>(
              type,
              'id,name,name_override,address,latitude,longitude,opening_hours_raw,opening_hours_override,website,image_url,lunch_available,lunch_menu_url,dinner_menu_url,beer_price_eur,wifi,google_rating,google_rating_count'
            );
            return fallback.map((v) => ({ ...v, google_opening_hours: null, google_place_id: null }));
          } catch (legacyErr) {
            console.warn(
              '[VenueMapNative] retrying without name_override/dinner_menu_url/beer_price_eur/wifi/google_rating columns',
              legacyErr
            );
            const fallback = await fetchAllVenues<
              Omit<RawVenue, 'name_override' | 'google_opening_hours' | 'dinner_menu_url' | 'beer_price_eur' | 'wifi' | 'google_rating' | 'google_rating_count'>
            >(type, 'id,name,address,latitude,longitude,opening_hours_raw,opening_hours_override,website,image_url,lunch_available,lunch_menu_url');
            return fallback.map((v) => ({
              ...v,
              name_override: null,
              google_opening_hours: null,
              dinner_menu_url: null,
              beer_price_eur: null,
              wifi: null,
              google_rating: null,
              google_rating_count: null,
              google_place_id: null,
            }));
          }
        }),
        // Nur bestätigt geschlossene Einträge von der Karte nehmen — "pending"
        // (gemeldet, aber noch nicht geprüft) bleibt sichtbar, siehe VenueListScreen.
        supabase.from('venue_closure_statuses').select('venue_id,status').eq('status', 'confirmed'),
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
        // Betreiber-Website > Google Places > OpenStreetMap.
        const effectiveHours = v.opening_hours_override ?? v.google_opening_hours ?? v.opening_hours_raw;
        return {
          id: v.id,
          name: v.name_override ?? v.name,
          address: v.address,
          latitude: v.latitude!,
          longitude: v.longitude!,
          opening_hours_raw: effectiveHours,
          open: isOpenNow(effectiveHours),
          website: v.website,
          image_url: v.image_url,
          lunch_available: v.lunch_available ?? false,
          lunch_menu_url: v.lunch_menu_url,
          dinner_menu_url: v.dinner_menu_url,
          beer_price_eur: v.beer_price_eur,
          wifi: v.wifi,
          google_rating: v.google_rating,
          google_rating_count: v.google_rating_count,
          google_place_id: v.google_place_id,
        };
      });
  }, [cachedMarkers, venues, closedIds]);

  const hasTarget = targetLat != null && targetLng != null && !Number.isNaN(targetLat) && !Number.isNaN(targetLng);

  // "Jetzt geöffnet"-Filter erst nach dem Öffnungsstatus-Mapping anwenden,
  // nicht schon in der Supabase-Abfrage — der Status hängt vom aktuellen
  // Zeitpunkt ab und wird clientseitig aus opening_hours_raw berechnet.
  const visibleMarkers = useMemo(
    () =>
      markers
        .filter((m) => !onlyOpen || m.open === true)
        .filter((m) => !lunchOnly || m.lunch_available),
    [markers, onlyOpen, lunchOnly]
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
          ref={leafletRef}
          venues={visibleMarkers}
          centerLat={hasTarget ? targetLat! : userLocation?.lat ?? MUNICH_CENTER.lat}
          centerLng={hasTarget ? targetLng! : userLocation?.lng ?? MUNICH_CENTER.lng}
          zoom={hasTarget ? 16 : userLocation ? 15 : 13}
          userLocation={userLocation}
          targetId={hasTarget ? targetId ?? null : null}
        />
      </Suspense>
      <MapCategorySwitcher active={MAP_CATEGORY[type]} />
      {userLocation && (
        <TouchableOpacity
          style={styles.locateButton}
          onPress={() => leafletRef.current?.flyToUserLocation()}
        >
          <Ionicons name="locate" size={22} color="#fff" />
        </TouchableOpacity>
      )}
      <View style={styles.filterRow}>
        <TouchableOpacity
          style={[styles.filterButton, onlyOpen && styles.filterButtonActive]}
          onPress={() => setOnlyOpen((v) => !v)}
        >
          <Ionicons name="time-outline" size={15} color={onlyOpen ? '#000' : '#fff'} />
          <Text style={[styles.filterButtonText, onlyOpen && styles.filterButtonTextActive]}>
            {t('venueMap.openNow')} ({markers.filter((m) => m.open === true).length})
          </Text>
        </TouchableOpacity>
        {type === 'restaurant' && (
          <TouchableOpacity
            style={[styles.filterButton, lunchOnly && styles.filterButtonActive]}
            onPress={() => setLunchOnly((v) => !v)}
          >
            <Ionicons name="sunny-outline" size={15} color={lunchOnly ? '#000' : '#fff'} />
            <Text style={[styles.filterButtonText, lunchOnly && styles.filterButtonTextActive]}>
              {t('venueMap.lunch')} ({markers.filter((m) => m.lunch_available).length})
            </Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' },
  filterRow: {
    position: 'absolute',
    top: 60,
    alignSelf: 'center',
    flexDirection: 'row',
    gap: 8,
    zIndex: 1000,
  },
  filterButton: {
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
  locateButton: {
    position: 'absolute',
    // 90 statt 24: die BottomTabBar wird auch auf Kartenscreens angezeigt
    // (position: absolute, ~54-64px hoch) und hätte den Button bei einem
    // niedrigeren Wert fast komplett verdeckt (per Nutzer-Feedback) — 90
    // ist bereits der etablierte Sicherheitsabstand in dieser Codebase
    // (siehe backToTopBtn in VenueListScreen.tsx).
    bottom: 90,
    right: 16,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(20,20,20,0.92)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1000,
  },
});
