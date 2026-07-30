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
import { fetchAllVenues } from '../lib/fetchAllVenues';
import { useVenueFavorites } from '../lib/venueFavorites';
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
  cuisine: string | null;
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
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [cuisineFilter, setCuisineFilter] = useState<string | null>(null);
  const { favorites, isFavorite, toggleFavorite } = useVenueFavorites();

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
      const [venuesData, eventsRes, reportsRes] = await Promise.all([
        // Supabase deckelt eine einzelne Abfrage hart bei 1000 Zeilen — bei
        // 2263 Restaurants hätte ein einfaches .select() über die Hälfte
        // verschluckt (siehe app/lib/fetchAllVenues.ts).
        fetchAllVenues<Venue>(
          type,
          'id,name,address,latitude,longitude,opening_hours_raw,opening_hours_override,website,phone,image_url,cuisine'
        ).catch(async (err) => {
          // cuisine kam erst mit 0016_venues_cuisine.sql dazu — falls diese
          // Migration noch nicht angewendet wurde, soll die Liste trotzdem
          // funktionieren (nur ohne Küchen-Badge/Filter) statt komplett leer
          // zu bleiben.
          console.warn('[VenueListScreen] retrying without cuisine column', err);
          const fallback = await fetchAllVenues<Omit<Venue, 'cuisine'>>(
            type,
            'id,name,address,latitude,longitude,opening_hours_raw,opening_hours_override,website,phone,image_url'
          );
          return fallback.map((v) => ({ ...v, cuisine: null }));
        }),
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
      setVenues(venuesData.sort((a, b) => a.name.localeCompare(b.name, 'de')));
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

  // Top-Küchen für den Schnellfilter (nur bei Restaurants sinnvoll — Bars
  // pflegen den OSM-cuisine-Tag praktisch nie). Nach Häufigkeit sortiert,
  // auf eine überschaubare Anzahl begrenzt statt aller ~40 vorkommenden
  // Werte, sonst würde die Chip-Zeile unbrauchbar lang.
  const cuisineOptions = useMemo(() => {
    if (type !== 'restaurant') return [];
    const counts = new Map<string, number>();
    for (const v of venues) {
      if (!v.cuisine) continue;
      for (const c of v.cuisine.split(';')) {
        const key = c.trim();
        if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([key]) => key);
  }, [venues, type]);

  const filteredVenues = useMemo(() => {
    return enrichedVenues
      .filter((v) => fuzzyMatch([v.name, v.address, v.cuisine].filter(Boolean).join(' '), search))
      .filter((v) => !onlyOpen || v.open === true)
      .filter((v) => !cuisineFilter || v.cuisine?.split(';').map((c) => c.trim()).includes(cuisineFilter))
      .sort((a, b) => {
        // Favoriten immer zuerst — der Grund, warum man einen Ort favorisiert
        // hat, ändert sich nicht danach, ob er gerade offen hat oder wie weit
        // er weg ist.
        const favDiff = Number(isFavorite(b.id)) - Number(isFavorite(a.id));
        if (favDiff !== 0) return favDiff;
        // Bei aktiver Nähe-Suche zählt nur die Entfernung — der eigentliche
        // Zweck ist "was ist gleich um die Ecke", ein offener Ort 3km weiter
        // weg soll einen geschlossenen direkt nebenan nicht überstimmen.
        if (a.distanceKm != null && b.distanceKm != null) return a.distanceKm - b.distanceKm;
        const priorityDiff = OPEN_PRIORITY[openState(a.open)] - OPEN_PRIORITY[openState(b.open)];
        if (priorityDiff !== 0) return priorityDiff;
        return a.name.localeCompare(b.name, 'de');
      });
  }, [enrichedVenues, search, onlyOpen, cuisineFilter, favorites]);

  const openCount = useMemo(() => filteredVenues.filter((v) => v.open === true).length, [filteredVenues]);

  const switcherActive = type === 'bar' ? 'bars' : 'restaurants';

  const hasAnyActiveFilter = search.trim() !== '' || onlyOpen || cuisineFilter !== null;
  function resetAllFilters() {
    setSearch('');
    setOnlyOpen(false);
    setCuisineFilter(null);
  }

  if (loading) {
    // Platzhalter-Karten statt nacktem Spinner — an die Eventseite angelehnt
    // (index.tsx), damit sich der Ladezustand über alle drei Reiter gleich
    // anfühlt statt nur bei Events poliert zu wirken.
    return (
      <SafeAreaView style={styles.loadingContainer}>
        {Array.from({ length: 6 }).map((_, i) => (
          <View key={i} style={styles.skeletonCard}>
            <View style={styles.skeletonThumb} />
            <View style={styles.skeletonBody}>
              <View style={styles.skeletonLine} />
              <View style={[styles.skeletonLine, styles.skeletonLineShort]} />
            </View>
          </View>
        ))}
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
            {hasAnyActiveFilter && (
              <TouchableOpacity onPress={resetAllFilters}>
                <Text style={styles.resetLink}>Alle Filter zurücksetzen</Text>
              </TouchableOpacity>
            )}
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
            style={[styles.iconButton, onlyOpen && styles.iconButtonActive]}
            onPress={() => setOnlyOpen((v) => !v)}
          >
            <Ionicons name="time-outline" size={16} color={onlyOpen ? '#000' : '#ccc'} />
          </TouchableOpacity>
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

        {cuisineOptions.length > 0 && (
          <FlatList
            horizontal
            data={['Alle', ...cuisineOptions]}
            keyExtractor={(c) => c}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.cuisineRow}
            renderItem={({ item: cuisine }) => {
              const active = cuisine === 'Alle' ? !cuisineFilter : cuisineFilter === cuisine;
              return (
                <TouchableOpacity
                  style={[styles.cuisineChip, active && styles.cuisineChipActive]}
                  onPress={() => setCuisineFilter(cuisine === 'Alle' ? null : cuisine)}
                >
                  <Text style={[styles.cuisineChipText, active && styles.cuisineChipTextActive]}>{cuisine}</Text>
                </TouchableOpacity>
              );
            }}
          />
        )}
      </LinearGradient>

      <FlatList
        data={filteredVenues}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Ionicons name={config.icon} size={40} color="#444" />
            <Text style={styles.emptyTitle}>{config.emptyText}</Text>
            {hasAnyActiveFilter ? (
              <>
                <Text style={styles.emptyHint}>Mit den aktuellen Filtern gibt es nichts zu sehen.</Text>
                <TouchableOpacity style={styles.emptyResetButton} onPress={resetAllFilters}>
                  <Text style={styles.emptyResetButtonText}>Alle Filter zurücksetzen</Text>
                </TouchableOpacity>
              </>
            ) : (
              <Text style={styles.emptyHint}>Schau später nochmal vorbei.</Text>
            )}
          </View>
        }
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
              <View style={styles.cardFooterLinks}>
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
                {item.phone && (
                  <TouchableOpacity
                    onPress={(e) => {
                      e.stopPropagation();
                      Linking.openURL(`tel:${item.phone}`);
                    }}
                  >
                    <Text style={styles.websiteLink}>Anrufen</Text>
                  </TouchableOpacity>
                )}
              </View>
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

          const favoriteButton = (
            <TouchableOpacity
              style={styles.favoriteBtn}
              onPress={(e) => {
                e.stopPropagation();
                toggleFavorite(item.id);
              }}
            >
              <Ionicons
                name={isFavorite(item.id) ? 'heart' : 'heart-outline'}
                size={18}
                color={isFavorite(item.id) ? '#ff4d6d' : '#fff'}
              />
            </TouchableOpacity>
          );

          const cuisineLabel = item.cuisine?.split(';')[0]?.trim();

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
                    <View style={styles.cardHeaderBadges}>
                      {item.open === true && <Text style={styles.openBadge}>Geöffnet</Text>}
                      {item.open === false && <Text style={styles.closedBadge}>Geschlossen</Text>}
                      {favoriteButton}
                    </View>
                  </View>
                  {(item.address || item.distanceKm != null || cuisineLabel) && (
                    <Text style={styles.venueAddress}>
                      {cuisineLabel ? `${cuisineLabel} · ` : ''}
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
                <View style={styles.favoriteBtnOverlay}>{favoriteButton}</View>
                {item.open === true && <Text style={[styles.openBadge, styles.badgeOverlay]}>Geöffnet</Text>}
                {item.open === false && <Text style={[styles.closedBadge, styles.badgeOverlay]}>Geschlossen</Text>}
              </View>
              <View style={styles.cardsBody}>
                <Text style={styles.venueName}>{item.name}</Text>
                {(item.address || item.distanceKm != null || cuisineLabel) && (
                  <Text style={styles.venueAddress}>
                    {cuisineLabel ? `${cuisineLabel} · ` : ''}
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
  loadingContainer: { flex: 1, backgroundColor: '#000', paddingTop: 24, paddingHorizontal: 16 },
  skeletonCard: {
    flexDirection: 'row',
    backgroundColor: '#141414',
    borderRadius: 16,
    padding: 14,
    marginBottom: 10,
  },
  skeletonThumb: { width: 72, height: 72, borderRadius: 12, backgroundColor: '#1f1f1f', marginRight: 12 },
  skeletonBody: { flex: 1, justifyContent: 'center', gap: 8 },
  skeletonLine: { height: 12, borderRadius: 6, backgroundColor: '#1f1f1f', width: '80%' },
  skeletonLineShort: { width: '50%' },
  resetLink: { color: '#0af', fontSize: 12, fontWeight: '600', marginTop: 4 },
  emptyState: { alignItems: 'center', marginTop: 60, paddingHorizontal: 32, gap: 6 },
  emptyTitle: { color: '#ccc', fontSize: 16, fontWeight: '700', marginTop: 12 },
  emptyHint: { color: '#666', fontSize: 13, textAlign: 'center' },
  emptyResetButton: {
    marginTop: 14,
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 20,
    backgroundColor: '#0af',
  },
  emptyResetButtonText: { color: '#000', fontWeight: '700', fontSize: 14 },
  banner: { borderBottomLeftRadius: 28, borderBottomRightRadius: 28, paddingBottom: 16 },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: 16,
    paddingTop: 20,
  },
  header: { fontSize: 30, fontWeight: '800', color: '#fff' },
  cuisineRow: { paddingHorizontal: 16, marginTop: 12, gap: 8 },
  cuisineChip: {
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginRight: 8,
  },
  cuisineChipActive: { backgroundColor: '#0af' },
  cuisineChipText: { color: '#ccc', fontSize: 13, fontWeight: '600' },
  cuisineChipTextActive: { color: '#000' },
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
  cardHeaderBadges: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  favoriteBtn: { padding: 2 },
  favoriteBtnOverlay: { position: 'absolute', top: 10, left: 10 },
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
  cardFooterLinks: { flexDirection: 'row', gap: 14 },
  websiteLink: { color: '#0af', fontSize: 13 },
  reportLink: { color: '#555', fontSize: 12 },
  pendingBadge: { color: '#f2c94c', fontSize: 12, fontWeight: '600', marginTop: 8 },
});
