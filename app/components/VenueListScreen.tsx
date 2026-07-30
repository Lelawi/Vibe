import { useEffect, useMemo, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  FlatList,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  SafeAreaView,
  Image,
  Linking,
  Platform,
  Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { canonicalizeVenue } from '../lib/venue';
import { isOpenNow, todayLabel } from '../lib/openingHours';
import { fuzzyMatch } from '../lib/fuzzySearch';
import { distanceKm, formatDistance } from '../lib/geo';
import ViewSwitcher from './ViewSwitcher';

export type VenueType = 'bar' | 'restaurant';

type Venue = {
  id: string;
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  opening_hours_raw: string | null;
  opening_hours_override: string | null;
  website: string | null;
  phone: string | null;
  image_url: string | null;
};

type ClosureStatus = 'pending' | 'confirmed' | 'rejected';

type NearbyEvent = {
  id: string;
  title: string;
  location_name: string | null;
  start_date: string;
  start_time: string | null;
};

const OPEN_PRIORITY: Record<'open' | 'unknown' | 'closed', number> = { open: 0, unknown: 1, closed: 2 };

function openState(open: boolean | null): 'open' | 'unknown' | 'closed' {
  return open === true ? 'open' : open === false ? 'closed' : 'unknown';
}

// Bars und Restaurants sind fachlich identisch (Ort mit regulären
// Öffnungszeiten statt Einzelterminen, siehe 0015_venues_generalize_for_
// restaurants.sql) — ein gemeinsamer Screen statt zweier Kopien, nur Titel/
// Icon/Routen/Texte unterscheiden sich je type.
const CONFIG: Record<VenueType, {
  title: string;
  icon: keyof typeof Ionicons.glyphMap;
  mapRoute: string;
  searchPlaceholder: string;
  emptyText: string;
  reportPrompt: (name: string) => string;
}> = {
  bar: {
    title: 'Bars',
    icon: 'beer-outline',
    mapRoute: '/bars-map',
    searchPlaceholder: 'Bar oder Adresse suchen...',
    emptyText: 'Keine Bars gefunden.',
    reportPrompt: (name) => `"${name}" als "gibt's nicht mehr" melden? Die Bar wird dann zur Prüfung markiert.`,
  },
  restaurant: {
    title: 'Restaurants',
    icon: 'restaurant-outline',
    mapRoute: '/restaurants-map',
    searchPlaceholder: 'Restaurant oder Adresse suchen...',
    emptyText: 'Keine Restaurants gefunden.',
    reportPrompt: (name) => `"${name}" als "gibt's nicht mehr" melden? Das Restaurant wird dann zur Prüfung markiert.`,
  },
};

export default function VenueListScreen({ type }: { type: VenueType }) {
  const config = CONFIG[type];
  const router = useRouter();
  const [venues, setVenues] = useState<Venue[]>([]);
  const [nearbyEvents, setNearbyEvents] = useState<NearbyEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [locationStatus, setLocationStatus] = useState<'idle' | 'loading' | 'denied'>('idle');
  const [closureStatusByVenue, setClosureStatusByVenue] = useState<Map<string, ClosureStatus>>(new Map());
  // "cards" (großes Bild oben, an die Eventseite angelehnt) ist der Default;
  // "compact" (kleine Vorschau, mehr auf einen Blick) bleibt über den Toggle
  // erreichbar, falls die großen Bilder z.B. neben der Karte zu wuchtig wirken.
  const [viewMode, setViewMode] = useState<'cards' | 'compact'>('cards');

  function toggleNearby() {
    if (userLocation) {
      setUserLocation(null);
      setLocationStatus('idle');
      return;
    }
    if (Platform.OS !== 'web' || typeof navigator === 'undefined' || !navigator.geolocation) {
      setLocationStatus('denied');
      return;
    }
    setLocationStatus('loading');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setLocationStatus('idle');
      },
      () => setLocationStatus('denied'),
      { enableHighAccuracy: false, timeout: 10000 }
    );
  }

  useEffect(() => {
    async function load() {
      const today = new Date().toISOString().slice(0, 10);
      // Nur die nächsten 2 Tage statt aller künftigen Events laden: der
      // Anwendungsfall ist "was ist JETZT/heute Abend los", nicht
      // Wochen-Planung — hält diese eigene Abfrage klein und unabhängig von
      // der (viel größeren, paginierten) Hauptliste.
      const soon = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
      const [venuesRes, eventsRes, reportsRes] = await Promise.all([
        supabase
          .from('venues')
          .select('id,name,address,latitude,longitude,opening_hours_raw,opening_hours_override,website,phone,image_url')
          .eq('type', type)
          .order('name', { ascending: true }),
        supabase
          .from('events')
          .select('id,title,location_name,start_date,start_time')
          .gte('start_date', today)
          .lte('start_date', soon)
          .is('duplicate_of', null)
          .not('location_name', 'is', null)
          .limit(1000),
        supabase.from('venue_closure_reports').select('venue_id,status'),
      ]);
      setVenues(venuesRes.data ?? []);
      setNearbyEvents(eventsRes.data ?? []);
      setClosureStatusByVenue(
        new Map((reportsRes.data ?? []).map((r) => [r.venue_id as string, r.status as ClosureStatus]))
      );
      setLoading(false);
    }
    load();
  }, [type]);

  // Ein einzelner Tap (z.B. versehentlich beim Scrollen) darf einen Eintrag
  // nicht sofort und endgültig verschwinden lassen — daher 1) eine Rückfrage
  // vor dem Melden, und 2) selbst nach Bestätigung nur ein "pending"-Status
  // statt direktem Ausblenden. Der Eintrag bleibt sichtbar (mit Hinweis-
  // Badge), bis die Meldung geprüft wurde — das übernimmt vorerst manuell
  // Claude auf Zuruf (siehe collectors/scripts/review-closures.ts), da es
  // keine freie Datenquelle gibt, die "existiert nicht mehr" verlässlich
  // automatisch bestätigen könnte.
  function confirmReportClosed(venueId: string, venueName: string) {
    const message = config.reportPrompt(venueName);
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      if (window.confirm(message)) reportClosed(venueId, venueName);
      return;
    }
    Alert.alert('Melden?', message, [
      { text: 'Abbrechen', style: 'cancel' },
      { text: 'Melden', style: 'destructive', onPress: () => reportClosed(venueId, venueName) },
    ]);
  }

  async function reportClosed(venueId: string, venueName: string) {
    setClosureStatusByVenue((prev) => new Map(prev).set(venueId, 'pending'));
    const { error } = await supabase
      .from('venue_closure_reports')
      .upsert({ venue_id: venueId, status: 'pending' }, { onConflict: 'venue_id' });
    if (error && Platform.OS === 'web' && typeof window !== 'undefined') {
      window.alert(`Melden von "${venueName}" ist fehlgeschlagen.`);
    } else if (error) {
      Alert.alert('Fehler', `Melden von "${venueName}" ist fehlgeschlagen.`);
    }
  }

  // Programm der nächsten 2 Tage einem Ort zuordnen — über dieselbe Venue-
  // Kanonisierung, die auch der Location-Filter der Hauptliste nutzt
  // (app/lib/venue.ts), da OSM-Namen und die Location-Schreibweise der
  // Event-Quellen selten exakt übereinstimmen ("Wintergarten" vs.
  // "Wintergarten am Elisabethmarkt").
  const eventsByVenue = useMemo(() => {
    const map = new Map<string, NearbyEvent[]>();
    for (const e of nearbyEvents) {
      const key = canonicalizeVenue(e.location_name);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(e);
    }
    return map;
  }, [nearbyEvents]);

  const enrichedVenues = useMemo(() => {
    const now = new Date();
    return venues
      // Nur bestätigt geschlossene Einträge wirklich ausblenden — "pending"
      // bleibt sichtbar (siehe reportClosed-Kommentar), damit ein
      // versehentlicher Klick nichts unwiderruflich verschwinden lässt.
      .filter((v) => closureStatusByVenue.get(v.id) !== 'confirmed')
      .map((v) => {
        // Vom Betreiber gepflegte Öffnungszeiten (von der Website gescrapt)
        // sind zuverlässiger als der oft ungenaue/veraltete OSM-
        // opening_hours-Tag — wo vorhanden, hat der Override Vorrang.
        const effectiveHours = v.opening_hours_override ?? v.opening_hours_raw;
        return {
          ...v,
          effectiveHours,
          open: isOpenNow(effectiveHours, now),
          hoursToday: todayLabel(effectiveHours, now),
          program: eventsByVenue.get(canonicalizeVenue(v.name)) ?? [],
          closureStatus: closureStatusByVenue.get(v.id) ?? null,
          distanceKm:
            userLocation && v.latitude != null && v.longitude != null
              ? distanceKm(userLocation.lat, userLocation.lng, v.latitude, v.longitude)
              : null,
        };
      });
  }, [venues, eventsByVenue, userLocation, closureStatusByVenue]);

  const filteredVenues = useMemo(() => {
    return enrichedVenues
      .filter((v) => fuzzyMatch([v.name, v.address].filter(Boolean).join(' '), search))
      .sort((a, b) => {
        // Bei aktiver Nähe-Suche zählt nur die Entfernung — der eigentliche
        // Zweck ist "was ist gleich um die Ecke", ein offener Ort 3km weiter
        // weg soll einen geschlossenen direkt nebenan nicht überstimmen.
        if (a.distanceKm != null && b.distanceKm != null) return a.distanceKm - b.distanceKm;
        const priorityDiff = OPEN_PRIORITY[openState(a.open)] - OPEN_PRIORITY[openState(b.open)];
        if (priorityDiff !== 0) return priorityDiff;
        return a.name.localeCompare(b.name, 'de');
      });
  }, [enrichedVenues, search]);

  const openCount = useMemo(() => filteredVenues.filter((v) => v.open === true).length, [filteredVenues]);

  const switcherActive = type === 'bar' ? 'bars' : 'restaurants';

  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator size="large" color="#fff" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <LinearGradient
        colors={['#2a0a4a', '#12082e', '#000000']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.banner}
      >
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.header}>{config.title}</Text>
            <Text style={styles.subheader}>
              {openCount} von {filteredVenues.length} gerade geöffnet
            </Text>
          </View>
          <ViewSwitcher active={switcherActive} />
        </View>

        <View style={styles.toolRow}>
          <TextInput
            style={styles.search}
            placeholder={config.searchPlaceholder}
            placeholderTextColor="#666"
            value={search}
            onChangeText={setSearch}
          />
          {Platform.OS === 'web' && (
            <TouchableOpacity
              style={[styles.iconButton, userLocation && styles.iconButtonActive]}
              onPress={toggleNearby}
              disabled={locationStatus === 'loading'}
            >
              {locationStatus === 'loading' ? (
                <ActivityIndicator size="small" color="#999" />
              ) : (
                <Ionicons name="location-outline" size={16} color={userLocation ? '#000' : '#ccc'} />
              )}
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={styles.iconButton}
            onPress={() => setViewMode((m) => (m === 'cards' ? 'compact' : 'cards'))}
          >
            <Ionicons name={viewMode === 'cards' ? 'list-outline' : 'image-outline'} size={16} color="#ccc" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.mapButton} onPress={() => router.push(config.mapRoute)}>
            <Ionicons name="map-outline" size={15} color="#fff" />
            <Text style={styles.mapButtonText}>Karte</Text>
          </TouchableOpacity>
        </View>
      </LinearGradient>

      <FlatList
        data={filteredVenues}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={<Text style={styles.empty}>{config.emptyText}</Text>}
        renderItem={({ item }) => {
          const hasCoords = item.latitude != null && item.longitude != null;
          const onPress = () =>
            router.push({
              pathname: config.mapRoute,
              params: { id: item.id, lat: String(item.latitude), lng: String(item.longitude) },
            });

          const hoursNode = item.hoursToday ? (
            <Text style={styles.venueHours}>Heute: {item.hoursToday}</Text>
          ) : item.effectiveHours ? (
            <Text style={styles.venueHours}>{item.effectiveHours}</Text>
          ) : (
            <Text style={styles.venueHoursUnknown}>Öffnungszeiten unbekannt</Text>
          );

          const programNode = item.program.length > 0 && (
            <View style={styles.programWrap}>
              {item.program.map((ev) => (
                <TouchableOpacity
                  key={ev.id}
                  onPress={(e) => {
                    e.stopPropagation();
                    router.push(`/event/${ev.id}`);
                  }}
                >
                  <Text style={styles.programText}>
                    🎤 {ev.title}
                    {ev.start_time ? ` · ${ev.start_time.slice(0, 5)}` : ''}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          );

          const footerNode = (
            <View style={styles.cardFooterRow}>
              {item.website && (
                <TouchableOpacity
                  onPress={(e) => {
                    e.stopPropagation();
                    Linking.openURL(item.website!);
                  }}
                >
                  <Text style={styles.websiteLink}>Website öffnen</Text>
                </TouchableOpacity>
              )}
              {item.closureStatus !== 'pending' && (
                <TouchableOpacity
                  onPress={(e) => {
                    e.stopPropagation();
                    confirmReportClosed(item.id, item.name);
                  }}
                >
                  <Text style={styles.reportLink}>Gibt's nicht mehr?</Text>
                </TouchableOpacity>
              )}
            </View>
          );

          const image = item.image_url ? (
            <Image source={{ uri: item.image_url }} style={viewMode === 'cards' ? styles.cardsImage : styles.compactThumb} />
          ) : (
            <LinearGradient
              colors={['#2a0a4a', '#12082e']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={viewMode === 'cards' ? styles.cardsImage : styles.compactThumb}
            >
              <Ionicons name={config.icon} size={viewMode === 'cards' ? 30 : 22} color="rgba(255,255,255,0.35)" />
            </LinearGradient>
          );

          if (viewMode === 'compact') {
            return (
              <TouchableOpacity style={styles.compactCard} disabled={!hasCoords} onPress={onPress}>
                {image}
                <View style={styles.cardBody}>
                  <View style={styles.cardHeaderRow}>
                    <Text style={styles.venueName}>{item.name}</Text>
                    {item.open === true && <Text style={styles.openBadge}>Geöffnet</Text>}
                    {item.open === false && <Text style={styles.closedBadge}>Geschlossen</Text>}
                  </View>
                  {(item.address || item.distanceKm != null) && (
                    <Text style={styles.venueAddress}>
                      {item.address}
                      {item.address && item.distanceKm != null ? ' · ' : ''}
                      {item.distanceKm != null ? formatDistance(item.distanceKm) : ''}
                    </Text>
                  )}
                  {hoursNode}
                  {programNode}
                  {item.closureStatus === 'pending' && (
                    <Text style={styles.pendingBadge}>⏳ Als geschlossen gemeldet — wird geprüft</Text>
                  )}
                  {footerNode}
                </View>
              </TouchableOpacity>
            );
          }

          return (
            <TouchableOpacity style={styles.cardsCard} disabled={!hasCoords} onPress={onPress}>
              <View style={styles.cardsImageWrap}>
                {image}
                {item.open === true && <Text style={[styles.openBadge, styles.badgeOverlay]}>Geöffnet</Text>}
                {item.open === false && <Text style={[styles.closedBadge, styles.badgeOverlay]}>Geschlossen</Text>}
              </View>
              <View style={styles.cardsBody}>
                <Text style={styles.venueName}>{item.name}</Text>
                {(item.address || item.distanceKm != null) && (
                  <Text style={styles.venueAddress}>
                    {item.address}
                    {item.address && item.distanceKm != null ? ' · ' : ''}
                    {item.distanceKm != null ? formatDistance(item.distanceKm) : ''}
                  </Text>
                )}
                {hoursNode}
                {programNode}
                {item.closureStatus === 'pending' && (
                  <Text style={styles.pendingBadge}>⏳ Als geschlossen gemeldet — wird geprüft</Text>
                )}
                {footerNode}
              </View>
            </TouchableOpacity>
          );
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' },
  banner: { borderBottomLeftRadius: 28, borderBottomRightRadius: 28, paddingBottom: 16 },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: 16,
    paddingTop: 20,
  },
  header: { fontSize: 30, fontWeight: '800', color: '#fff' },
  subheader: { fontSize: 14, color: '#cbb8f0', marginTop: 2 },
  toolRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, marginTop: 16, alignItems: 'center' },
  search: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#fff',
    fontSize: 16,
  },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButtonActive: { backgroundColor: '#0af' },
  mapButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    borderRadius: 14,
    paddingHorizontal: 14,
    height: 44,
  },
  mapButtonText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  listContent: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 40 },
  empty: { color: '#666', textAlign: 'center', marginTop: 40 },
  // Kompakte Ansicht: kleine Vorschau, mehr Einträge auf einen Blick.
  compactCard: {
    flexDirection: 'row',
    backgroundColor: '#141414',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    padding: 14,
    marginBottom: 10,
  },
  compactThumb: {
    width: 72,
    height: 72,
    borderRadius: 12,
    marginRight: 12,
    backgroundColor: '#1a1a1a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Bild-Karten-Ansicht: großes Bild oben, an die Eventseite angelehnt
  // (index.tsx-Kartenlayout), statt der kleinen seitlichen Vorschau.
  cardsCard: {
    backgroundColor: '#141414',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    marginBottom: 14,
    overflow: 'hidden',
  },
  cardsImageWrap: { position: 'relative' },
  cardsImage: { width: '100%', height: 160, backgroundColor: '#1a1a1a', alignItems: 'center', justifyContent: 'center' },
  cardsBody: { padding: 14 },
  badgeOverlay: { position: 'absolute', top: 10, right: 10 },
  cardBody: { flex: 1 },
  cardHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  venueName: { color: '#fff', fontSize: 16, fontWeight: '700', flexShrink: 1 },
  openBadge: {
    fontSize: 11,
    fontWeight: '700',
    color: '#4ade80',
    backgroundColor: '#1a1a1aee',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  closedBadge: {
    fontSize: 11,
    fontWeight: '700',
    color: '#ff6b6b',
    backgroundColor: '#1a1a1aee',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  venueAddress: { color: '#999', fontSize: 13, marginTop: 4 },
  venueHours: { color: '#999', fontSize: 13, marginTop: 4 },
  venueHoursUnknown: { color: '#555', fontSize: 13, marginTop: 4, fontStyle: 'italic' },
  programWrap: { marginTop: 8, gap: 4 },
  programText: { color: '#5fd4ff', fontSize: 13 },
  cardFooterRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 },
  websiteLink: { color: '#0af', fontSize: 13 },
  reportLink: { color: '#555', fontSize: 12 },
  pendingBadge: { color: '#f2c94c', fontSize: 12, fontWeight: '600', marginTop: 8 },
});
