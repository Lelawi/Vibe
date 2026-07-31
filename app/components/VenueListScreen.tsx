import { useEffect, useMemo, useRef, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  FlatList,
  ScrollView,
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
import { setFilteredVenuesForMap } from '../lib/mapFilterCache';
import BottomTabBar from './BottomTabBar';

// Web-only <input type="range">-Styling für den Umkreis-Slider (siehe
// index.tsx) — reines HTML-Element statt @react-native-community/slider,
// dessen Web-Support über react-native-web unzuverlässig ist.
const radiusSliderStyle = {
  width: '100%' as const,
  accentColor: '#0af',
};

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
  lunch_available: boolean;
  lunch_menu_url: string | null;
  beer_price_eur: number | null;
};

const VENUE_BASE_COLUMNS =
  'id,name,address,latitude,longitude,opening_hours_raw,opening_hours_override,website,phone,image_url';

type ClosureStatus = 'pending' | 'confirmed' | 'rejected';

// Lädt Venues mit optionalen Spalten, die in aufeinanderfolgenden Migrationen
// dazukamen (cuisine: 0016, lunch_*: 0017, beer_price_eur: 0018) — schlägt
// die volle Spaltenliste fehl, weil eine Migration in dieser Supabase-
// Instanz noch nicht angewendet wurde, wird mit jeweils einer Spaltengruppe
// weniger erneut versucht, statt die ganze Liste leer zu lassen. Ersetzt die
// zuvor manuell verschachtelten .catch()-Ketten, die mit jeder neuen
// optionalen Spalte eine Ebene tiefer wurden.
async function fetchVenuesResilient(type: VenueType): Promise<Venue[]> {
  const attempts: { columns: string; fill: (v: Record<string, unknown>) => Venue }[] = [
    {
      columns: `${VENUE_BASE_COLUMNS},cuisine,lunch_available,lunch_menu_url,beer_price_eur`,
      fill: (v) => v as unknown as Venue,
    },
    {
      columns: `${VENUE_BASE_COLUMNS},cuisine,lunch_available,lunch_menu_url`,
      fill: (v) => ({ ...v, beer_price_eur: null } as unknown as Venue),
    },
    {
      columns: `${VENUE_BASE_COLUMNS},cuisine`,
      fill: (v) => ({ ...v, lunch_available: false, lunch_menu_url: null, beer_price_eur: null } as unknown as Venue),
    },
    {
      columns: VENUE_BASE_COLUMNS,
      fill: (v) =>
        ({ ...v, cuisine: null, lunch_available: false, lunch_menu_url: null, beer_price_eur: null } as unknown as Venue),
    },
  ];

  for (let i = 0; i < attempts.length; i++) {
    try {
      const data = await fetchAllVenues<Record<string, unknown>>(type, attempts[i].columns);
      return data.map(attempts[i].fill);
    } catch (err) {
      if (i === attempts.length - 1) throw err;
      console.warn(`[VenueListScreen] retrying with fewer columns (attempt ${i + 2}/${attempts.length})`, err);
    }
  }
  return [];
}

type NearbyEvent = {
  id: string;
  title: string;
  location_name: string | null;
  start_date: string;
  start_time: string | null;
};

type EnrichedVenue = Venue & {
  effectiveHours: string | null;
  open: boolean | null;
  hoursToday: string | null;
  program: NearbyEvent[];
  closureStatus: ClosureStatus | null;
  distanceKm: number | null;
};

// Eine eigene Zeilen-Union statt filteredVenues direkt als FlatList-data, nach
// demselben Muster wie index.tsx (ListRow: banner/featured/group): der
// Banner (Titel+Switcher+Karte) und der "nichts gefunden"-Hinweis sollen als
// normale Listenzeilen scrollen bzw. angezeigt werden, nicht über FlatLists
// eigenes ListEmptyComponent — das feuert nie, solange data mindestens die
// Banner-Zeile enthält.
type ListRow = { kind: 'banner' } | { kind: 'empty' } | { kind: 'venue'; venue: EnrichedVenue };

// Modul-level statt useState-Default: bleibt über einen Tab-Wechsel hinweg
// erhalten, obwohl der Screen (Stack.Screen pro Tab, kein Tabs-Navigator)
// bei jedem Wechsel komplett neu gemountet wird. Ohne das flackerte bei
// jedem Zurückwechseln zu Bars/Restaurants wieder das Lade-Skeleton auf und
// alle 581/2270 Venues wurden erneut über mehrere Seiten von Supabase
// geholt — spürbar lange Wartezeit beim Tab-Switching (gleiches Problem wie
// bei den Events, siehe eventsCache in app/index.tsx). Mit Cache: sofort
// der zuletzt geladene Stand sichtbar, im Hintergrund läuft trotzdem ein
// stiller Refresh (siehe load()).
type VenueScreenCache = {
  venues: Venue[];
  nearbyEvents: NearbyEvent[];
  closureStatusByVenue: Map<string, ClosureStatus>;
};
const venueScreenCache = new Map<VenueType, VenueScreenCache>();

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
  const [venues, setVenues] = useState<Venue[]>(() => venueScreenCache.get(type)?.venues ?? []);
  const [nearbyEvents, setNearbyEvents] = useState<NearbyEvent[]>(() => venueScreenCache.get(type)?.nearbyEvents ?? []);
  const [loading, setLoading] = useState(() => !venueScreenCache.has(type));
  const [search, setSearch] = useState('');
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [locationStatus, setLocationStatus] = useState<'idle' | 'loading' | 'denied'>('idle');
  const [closureStatusByVenue, setClosureStatusByVenue] = useState<Map<string, ClosureStatus>>(
    () => venueScreenCache.get(type)?.closureStatusByVenue ?? new Map()
  );
  // "compact" (kleine Vorschau links, viel auf einen Blick) ist der Default,
  // exakt wie die normale Event-Liste in index.tsx — "cards" (großes Bild
  // oben) bleibt für alle erreichbar, die die Bild-Vorschau lieber größer
  // haben wollen, ist bei Events aber nur der Sonderfall der "Empfohlen für
  // dich"-Karussellzeile, nicht der Standard.
  const [viewMode, setViewMode] = useState<'compact' | 'cards'>('compact');
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [cuisineFilter, setCuisineFilter] = useState<string | null>(null);
  const [lunchOnly, setLunchOnly] = useState(false);
  // Fehlte bisher hier komplett, obwohl der Nähe-Button bei Events dieselbe
  // Zusatzauswahl aufklappt (Umkreis-Slider, null = "Alle").
  const [nearbyRadiusKm, setNearbyRadiusKm] = useState<number | null>(null);
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [showBackToTop, setShowBackToTop] = useState(false);
  const listRef = useRef<FlatList<ListRow>>(null);
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

  // Eigenständige Funktion statt reiner useEffect-Closure, damit sie auch vom
  // manuellen Aktualisieren-Button erneut aufgerufen werden kann — echtes
  // Pull-to-refresh via RefreshControl ist auf react-native-web ein reiner
  // No-op-Stub (rendert nur eine leere View, ignoriert refreshing/onRefresh
  // komplett), also nutzlos auf dem PWA-Hauptkanal dieser App.
  async function load(isRefresh = false) {
    if (isRefresh) setRefreshing(true);
    try {
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
        fetchVenuesResilient(type),
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
      const sortedVenues = venuesData.sort((a, b) => a.name.localeCompare(b.name, 'de'));
      const nearby = eventsRes.data ?? [];
      const closureMap = new Map(
        (reportsRes.data ?? []).map((r) => [r.venue_id as string, r.status as ClosureStatus])
      );
      setVenues(sortedVenues);
      setNearbyEvents(nearby);
      setClosureStatusByVenue(closureMap);
      venueScreenCache.set(type, { venues: sortedVenues, nearbyEvents: nearby, closureStatusByVenue: closureMap });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      .filter((v) => !lunchOnly || v.lunch_available)
      .filter((v) => !showFavoritesOnly || isFavorite(v.id))
      .filter((v) => {
        // Nur bei aktivem Umkreis-Slider einschränken — Orte ohne Koordinaten
        // (distanceKm null) fallen dann automatisch raus, da ihre Entfernung
        // nicht bestimmbar ist (gleiche Logik wie der Umkreis-Filter in
        // index.tsx).
        if (!userLocation || nearbyRadiusKm === null) return true;
        return v.distanceKm != null && v.distanceKm <= nearbyRadiusKm;
      })
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
  }, [enrichedVenues, search, onlyOpen, cuisineFilter, lunchOnly, showFavoritesOnly, favorites, userLocation, nearbyRadiusKm]);

  // Damit die Karte (VenueMapNative.web.tsx) exakt dieselben Treffer zeigen
  // kann wie die gerade aktive Filterkombination hier, ohne die komplette
  // Filterlogik (Suche/Öffnungszeiten/Küche/Mittagslunch/Favoriten/Nähe) ein
  // zweites Mal zu implementieren — siehe mapFilterCache.ts. Nicht während
  // loading publizieren: sonst würde ein Wechsel zur Karte mitten im
  // allerersten Ladevorgang (bevor überhaupt Daten da sind) ein leeres
  // Zwischenergebnis cachen, das die Karte dann fälschlich als "wirklich
  // null Treffer" statt als "noch kein Filterkontext vorhanden" läse.
  useEffect(() => {
    if (loading) return;
    setFilteredVenuesForMap(
      type,
      filteredVenues
        .filter((v) => v.latitude != null && v.longitude != null)
        .map((v) => ({
          id: v.id,
          name: v.name,
          address: v.address,
          latitude: v.latitude!,
          longitude: v.longitude!,
          opening_hours_raw: v.effectiveHours,
          open: v.open,
          website: v.website,
          image_url: v.image_url,
          lunch_available: v.lunch_available,
          lunch_menu_url: v.lunch_menu_url,
          beer_price_eur: v.beer_price_eur,
        }))
    );
  }, [type, filteredVenues, loading]);

  const openCount = useMemo(() => filteredVenues.filter((v) => v.open === true).length, [filteredVenues]);
  const switcherActive = type === 'bar' ? 'bars' : 'restaurants';
  const hasAnyActiveFilter = search.trim() !== '' || onlyOpen || cuisineFilter !== null || lunchOnly || showFavoritesOnly;

  function resetAllFilters() {
    setSearch('');
    setOnlyOpen(false);
    setCuisineFilter(null);
    setLunchOnly(false);
    setShowFavoritesOnly(false);
  }

  const listData: ListRow[] = useMemo(() => {
    const rows: ListRow[] = [{ kind: 'banner' }];
    if (filteredVenues.length === 0) rows.push({ kind: 'empty' });
    else filteredVenues.forEach((venue) => rows.push({ kind: 'venue', venue }));
    return rows;
  }, [filteredVenues]);

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
        <BottomTabBar active={switcherActive} mapRoute={config.mapRoute} />
      </SafeAreaView>
    );
  }

  // Scrollt als normale erste Zeile weg statt gepinnt zu bleiben — exakt wie
  // der "Vibe"-Banner in index.tsx, damit der angeheftete Bereich (Suche/
  // Filter) auf dem Handy nicht zu viel Platz frisst.
  const bannerSection = (
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
      </View>
    </LinearGradient>
  );

  const listHeader = (
    <View style={styles.listHeaderWrap}>
      <View style={styles.stickyControls}>
        <View style={styles.searchWrap}>
          <TextInput
            style={[styles.search, styles.searchInput]}
            placeholder={config.searchPlaceholder}
            placeholderTextColor="#666"
            value={search}
            onChangeText={setSearch}
          />
          {search.length > 0 && (
            <TouchableOpacity style={styles.searchClearBtn} onPress={() => setSearch('')}>
              <Text style={styles.searchClearBtnText}>✕</Text>
            </TouchableOpacity>
          )}
        </View>

        {cuisineOptions.length > 0 && (
          <View style={styles.controlRow}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.cuisineScrollContent}
              style={styles.cuisineScroll}
            >
              {['Alle', ...cuisineOptions].map((cuisine) => {
                const active = cuisine === 'Alle' ? !cuisineFilter : cuisineFilter === cuisine;
                return (
                  <TouchableOpacity
                    key={cuisine}
                    style={[styles.filterChip, active && styles.filterChipActive]}
                    onPress={() => setCuisineFilter(cuisine === 'Alle' || cuisineFilter === cuisine ? null : cuisine)}
                  >
                    <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>{cuisine}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        )}

        <View style={styles.actionButtonRowWrap}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.actionButtonRow}
          >
            <TouchableOpacity
              style={[styles.filterButton, onlyOpen && styles.filterChipActive]}
              onPress={() => setOnlyOpen((v) => !v)}
            >
              <Ionicons name="time-outline" size={16} color={onlyOpen ? '#000' : '#999'} />
              <Text style={[styles.filterButtonText, onlyOpen && styles.filterChipTextActive]}>Nur geöffnet</Text>
            </TouchableOpacity>

            {type === 'restaurant' && (
              <TouchableOpacity
                style={[styles.filterButton, lunchOnly && styles.filterChipActive]}
                onPress={() => setLunchOnly((v) => !v)}
              >
                <Ionicons name="sunny-outline" size={16} color={lunchOnly ? '#000' : '#999'} />
                <Text style={[styles.filterButtonText, lunchOnly && styles.filterChipTextActive]}>Mittagslunch</Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity
              style={[styles.filterButton, showFavoritesOnly && styles.filterChipActive]}
              onPress={() => setShowFavoritesOnly((v) => !v)}
            >
              <Ionicons
                name={showFavoritesOnly ? 'heart' : 'heart-outline'}
                size={16}
                color={showFavoritesOnly ? '#000' : '#999'}
              />
              <Text style={[styles.filterButtonText, showFavoritesOnly && styles.filterChipTextActive]}>
                Favoriten
              </Text>
            </TouchableOpacity>

            {Platform.OS === 'web' && (
              <TouchableOpacity
                style={[styles.filterButton, userLocation && styles.filterChipActive]}
                onPress={toggleNearby}
                disabled={locationStatus === 'loading'}
              >
                {locationStatus === 'loading' ? (
                  <ActivityIndicator size="small" color="#999" />
                ) : (
                  <Ionicons name="location-outline" size={16} color={userLocation ? '#000' : '#999'} />
                )}
                <Text style={[styles.filterButtonText, userLocation && styles.filterChipTextActive]}>
                  {locationStatus === 'loading' ? 'Lädt…' : 'Nähe'}
                </Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity
              style={styles.filterButton}
              onPress={() => setViewMode((m) => (m === 'compact' ? 'cards' : 'compact'))}
            >
              <Ionicons name={viewMode === 'compact' ? 'image-outline' : 'list-outline'} size={16} color="#999" />
              <Text style={styles.filterButtonText}>{viewMode === 'compact' ? 'Bild-Karten' : 'Kompakt'}</Text>
            </TouchableOpacity>

            {/* Ersetzt echtes Pull-to-refresh, das auf react-native-web nicht
                funktioniert (RefreshControl ist dort ein reiner No-op-Stub). */}
            <TouchableOpacity style={styles.filterButton} onPress={() => load(true)} disabled={refreshing}>
              {refreshing ? (
                <ActivityIndicator size="small" color="#999" />
              ) : (
                <Ionicons name="refresh-outline" size={16} color="#999" />
              )}
              <Text style={styles.filterButtonText}>Aktualisieren</Text>
            </TouchableOpacity>
          </ScrollView>
          <LinearGradient
            pointerEvents="none"
            colors={['#0000', '#000']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.actionButtonRowFade}
          />
        </View>

        <View style={styles.resultCountRow}>
          <Text style={styles.resultCount}>
            {filteredVenues.length} {filteredVenues.length === 1 ? config.title.slice(0, -1) : config.title} gefunden
          </Text>
          {hasAnyActiveFilter && (
            <TouchableOpacity onPress={resetAllFilters}>
              <Text style={styles.resultCountResetLink}>Alle Filter zurücksetzen</Text>
            </TouchableOpacity>
          )}
        </View>

        {locationStatus === 'denied' && (
          <Text style={styles.locationHint}>
            Standort nicht verfügbar — bitte Standortzugriff im Browser erlauben.
          </Text>
        )}

        {userLocation && (
          <View style={styles.radiusRow}>
            <Text style={styles.radiusLabel}>
              Umkreis: {nearbyRadiusKm === null ? 'Alle' : `${nearbyRadiusKm} km`}
            </Text>
            <View style={styles.radiusSliderWrap}>
              {/* Web-only wie das ganze Nähe-Feature (Platform.OS==='web' schon
                  eine Ebene höher am Nähe-Button selbst). */}
              <input
                type="range"
                min={1}
                max={25}
                step={1}
                value={nearbyRadiusKm ?? 25}
                onChange={(e) => setNearbyRadiusKm(Number(e.target.value))}
                style={radiusSliderStyle}
              />
            </View>
            <TouchableOpacity onPress={() => setNearbyRadiusKm(null)}>
              <Text style={[styles.radiusAllLink, nearbyRadiusKm === null && styles.radiusAllLinkActive]}>
                Alle
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </View>
  );

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        ref={listRef}
        data={listData}
        keyExtractor={(row) => (row.kind === 'venue' ? row.venue.id : row.kind)}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={listHeader}
        stickyHeaderIndices={[0]}
        keyboardShouldPersistTaps="handled"
        onScroll={(e) => setShowBackToTop(e.nativeEvent.contentOffset.y > 600)}
        scrollEventThrottle={150}
        renderItem={({ item: row }) => {
          if (row.kind === 'banner') return bannerSection;

          if (row.kind === 'empty') {
            return (
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
            );
          }

          const item = row.venue;
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
              {(item.website || item.phone || item.lunch_menu_url) && (
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
                  {item.lunch_menu_url && (
                    <TouchableOpacity
                      onPress={(e) => {
                        e.stopPropagation();
                        Linking.openURL(item.lunch_menu_url!);
                      }}
                    >
                      <Text style={styles.websiteLink}>Mittagskarte</Text>
                    </TouchableOpacity>
                  )}
                </View>
              )}
              {/* Eigene Zeile statt neben den Links (space-between): auf dem
                  Handy reichte die Breite oft nicht für Website+Anrufen+
                  Mittagskarte UND diesen Link nebeneinander — sie klebten
                  ohne jeden Abstand aneinander (per Nutzer-Screenshot
                  gemeldet). Als eigene Zeile ist das unabhängig davon, wie
                  viele Links links stehen, immer lesbar. */}
              {item.closureStatus !== 'pending' && (
                <TouchableOpacity
                  style={styles.reportLinkRow}
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
          const lunchNode = item.lunch_available && (
            <Text style={styles.lunchBadge}>🍽️ Mittagslunch</Text>
          );
          const beerPriceNode = item.beer_price_eur != null && (
            <Text style={styles.lunchBadge}>🍺 0,5l Helles: {item.beer_price_eur.toFixed(2).replace('.', ',')} €</Text>
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

          if (viewMode === 'cards') {
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
                  {lunchNode}
                  {beerPriceNode}
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
                {lunchNode}
                {beerPriceNode}
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
      {showBackToTop && (
        <TouchableOpacity
          style={styles.backToTopBtn}
          onPress={() => listRef.current?.scrollToOffset({ offset: 0, animated: true })}
        >
          <Ionicons name="arrow-up" size={20} color="#000" />
        </TouchableOpacity>
      )}
      <BottomTabBar active={switcherActive} mapRoute={config.mapRoute} />
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
  // Deckt den gesamten gepinnten Header opak ab (siehe stickyHeaderIndices
  // an der FlatList) — sonst würden hochscrollende Karten durch transparente
  // Lücken zwischen den Header-Zeilen hindurchschimmern.
  listHeaderWrap: { backgroundColor: '#000' },
  stickyControls: { paddingTop: 12 },
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
  banner: { borderBottomLeftRadius: 28, borderBottomRightRadius: 28, paddingBottom: 22 },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 20,
  },
  header: { fontSize: 30, fontWeight: '800', color: '#fff' },
  subheader: { fontSize: 14, color: '#cbb8f0' },
  search: {
    backgroundColor: '#141414',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#fff',
    // Mind. 16px, sonst zoomt iOS Safari beim Fokussieren automatisch rein.
    fontSize: 16,
  },
  searchWrap: { marginHorizontal: 16, marginTop: 16, marginBottom: 14, position: 'relative', justifyContent: 'center' },
  searchInput: { paddingRight: 38 },
  searchClearBtn: {
    position: 'absolute',
    right: 6,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  searchClearBtnText: { color: '#888', fontSize: 15, fontWeight: '700' },
  controlRow: { flexDirection: 'row', alignItems: 'center', paddingLeft: 16, marginBottom: 8 },
  cuisineScroll: { flex: 1 },
  cuisineScrollContent: { paddingRight: 8, alignItems: 'center' },
  filterChip: {
    backgroundColor: '#141414',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginRight: 8,
  },
  filterChipActive: { backgroundColor: '#0af' },
  filterChipText: { color: '#999', fontSize: 13, fontWeight: '600' },
  filterChipTextActive: { color: '#000' },
  actionButtonRowWrap: { position: 'relative' },
  actionButtonRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 8, gap: 10 },
  actionButtonRowFade: { position: 'absolute', right: 0, top: 0, bottom: 8, width: 28 },
  filterButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#141414',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  filterButtonText: { color: '#999', fontSize: 13, fontWeight: '600' },
  resultCountRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  resultCount: { color: '#666', fontSize: 12 },
  resultCountResetLink: { color: '#888', fontSize: 12, fontWeight: '600', textDecorationLine: 'underline' },
  locationHint: { color: '#888', fontSize: 12, paddingHorizontal: 16, marginBottom: 8 },
  radiusRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, marginBottom: 8, gap: 10 },
  radiusLabel: { color: '#888', fontSize: 12, minWidth: 84 },
  radiusSliderWrap: { flex: 1 },
  radiusAllLink: { color: '#666', fontSize: 12, fontWeight: '600', textDecorationLine: 'underline' },
  radiusAllLinkActive: { color: '#0af' },
  // paddingBottom deckt die fixe BottomTabBar ab, sonst wäre die letzte Karte
  // dahinter verdeckt.
  listContent: { paddingHorizontal: 16, paddingBottom: 90 },
  backToTopBtn: {
    position: 'absolute',
    right: 16,
    bottom: 90,
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#0af',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 4,
  },
  // Kompakte Ansicht: kleine Vorschau, mehr Einträge auf einen Blick — der
  // Standard, exakt wie die normale Event-Liste in index.tsx.
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
  // Bild-Karten-Ansicht: großes Bild oben (wie index.tsx's "Empfohlen für
  // dich"-Karussellkarten), über den Ansicht-Toggle erreichbar statt Standard.
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
    backgroundColor: '#4ade8022',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  closedBadge: {
    fontSize: 11,
    fontWeight: '700',
    color: '#ff6b6b',
    backgroundColor: '#ff6b6b22',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  venueAddress: { color: '#999', fontSize: 13, marginTop: 4 },
  venueHours: { color: '#999', fontSize: 13, marginTop: 4 },
  venueHoursUnknown: { color: '#555', fontSize: 13, marginTop: 4, fontStyle: 'italic' },
  lunchBadge: { color: '#f2c94c', fontSize: 12, fontWeight: '600', marginTop: 4 },
  programWrap: { marginTop: 8, gap: 4 },
  programText: { color: '#5fd4ff', fontSize: 13 },
  cardFooterRow: { marginTop: 8 },
  cardFooterLinks: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  websiteLink: { color: '#0af', fontSize: 13 },
  reportLinkRow: { alignSelf: 'flex-start', marginTop: 6 },
  reportLink: { color: '#555', fontSize: 12 },
  pendingBadge: { color: '#f2c94c', fontSize: 12, fontWeight: '600', marginTop: 8 },
});
