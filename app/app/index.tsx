import { useEffect, useMemo, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  Image,
  FlatList,
  ActivityIndicator,
  SafeAreaView,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Platform,
  Modal,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { supabase } from '../lib/supabase';
import { canonicalizeVenue } from '../lib/venue';
import { computeSeriesKey } from '../lib/seriesKey';
import { fuzzyMatch } from '../lib/fuzzySearch';
import { addEventsToCalendar } from '../lib/calendar';
import { useFavorites } from '../lib/favorites';

type Event = {
  id: string;
  title: string;
  category: string | null;
  subcategory: string | null;
  organizer: string | null;
  address: string | null;
  description: string | null;
  source_url: string | null;
  image_url: string | null;
  price_info: string | null;
  sold_out: boolean | null;
  start_date: string;
  start_time: string | null;
  location_name: string | null;
  latitude: number | null;
  longitude: number | null;
};

// Haversine-Formel für die Distanz zweier Koordinaten in km.
function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDistance(km: number): string {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
}

type DateFilter = 'all' | 'today' | 'tomorrow' | 'week' | 'weekend' | 'custom';

function formatDate(dateStr: string, timeStr: string | null) {
  const date = new Date(`${dateStr}T${timeStr ?? '00:00'}`);
  const dateFormatted = date.toLocaleDateString('de-DE', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
  });
  if (!timeStr) return dateFormatted;
  return `${dateFormatted} · ${timeStr.slice(0, 5)}`;
}

// "YYYY-MM-DD" -> "DD.MM." und "DD.MM.YYYY", damit die Suche auch das in
// Deutschland übliche numerische Format findet (formatDate() liefert nur
// den ausgeschriebenen Wochentag/Monat, z.B. "Di., 25. Aug.", worin "25.08"
// nicht als Teilstring vorkommt).
function toGermanNumericDates(dateStr: string): string {
  const [year, month, day] = dateStr.split('-');
  if (!year || !month || !day) return '';
  return `${day}.${month}. ${day}.${month}.${year}`;
}

function toLocalDateStr(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const WEEKDAY_LABELS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const MONTH_LABELS = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

// Baut ein 6x7-Raster für die Monatsansicht des Kalenders: führende/
// nachfolgende Tage aus Nachbarmonaten werden mitgeliefert (inMonth: false),
// damit das Raster immer volle Wochen zeigt statt abgeschnittener Zeilen.
function getMonthMatrix(year: number, month: number): { date: Date; inMonth: boolean }[] {
  const firstOfMonth = new Date(year, month, 1);
  // getDay(): 0=So..6=Sa -> auf Montag-Start (0=Mo..6=So) verschieben
  const startOffset = (firstOfMonth.getDay() + 6) % 7;
  const gridStart = new Date(year, month, 1 - startOffset);

  return Array.from({ length: 42 }, (_, i) => {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + i);
    return { date, inMonth: date.getMonth() === month };
  });
}

// Baut alle Datumsstrings zwischen zwei Tagen (inklusive), unabhängig davon,
// welcher der beiden zuerst angetippt wurde — für die "zweiter Tap = Zeitraum"-
// Kalenderauswahl (Touch-Äquivalent zu Shift-Klick).
function buildDateRangeArray(aStr: string, bStr: string): string[] {
  const a = new Date(aStr);
  const b = new Date(bStr);
  const start = a <= b ? a : b;
  const end = a <= b ? b : a;
  const result: string[] = [];
  const cur = new Date(start);
  while (cur <= end) {
    result.push(toLocalDateStr(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return result;
}

function arraysEqual(a: string[], b: string[]) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// Wenn eine Kalenderauswahl exakt einem der Schnellfilter (Heute, Morgen,
// Diese Woche, Wochenende) entspricht, soll der entsprechende Chip aktiv
// erscheinen statt einer redundanten "Custom"-Auswahl für dieselben Tage.
function matchesQuickFilter(dates: string[]): DateFilter | null {
  if (dates.length === 0) return null;
  const presets: DateFilter[] = ['today', 'tomorrow', 'week', 'weekend'];
  for (const preset of presets) {
    const { from, to } = getDateRange(preset);
    const presetDates = buildDateRangeArray(from, to ?? from);
    if (arraysEqual(dates, presetDates)) return preset;
  }
  return null;
}

function getDateRange(filter: DateFilter): { from: string; to: string | null } {
  const today = new Date();
  const todayStr = toLocalDateStr(today);

  if (filter === 'today') {
    return { from: todayStr, to: todayStr };
  }

  if (filter === 'tomorrow') {
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    const tomorrowStr = toLocalDateStr(tomorrow);
    return { from: tomorrowStr, to: tomorrowStr };
  }

  if (filter === 'week') {
    const in7Days = new Date(today);
    in7Days.setDate(today.getDate() + 6);
    return { from: todayStr, to: toLocalDateStr(in7Days) };
  }

  if (filter === 'weekend') {
    const dayOfWeek = today.getDay();
    const daysUntilSaturday = (6 - dayOfWeek + 7) % 7;
    const saturday = new Date(today);
    saturday.setDate(today.getDate() + daysUntilSaturday);
    const sunday = new Date(saturday);
    sunday.setDate(saturday.getDate() + 1);
    return { from: toLocalDateStr(saturday), to: toLocalDateStr(sunday) };
  }

  return { from: todayStr, to: null };
}

const DATE_FILTERS: { key: DateFilter; label: string }[] = [
  { key: 'all', label: 'Alle' },
  { key: 'today', label: 'Heute' },
  { key: 'tomorrow', label: 'Morgen' },
  { key: 'week', label: 'Diese Woche' },
  { key: 'weekend', label: 'Wochenende' },
];

const RADIUS_OPTIONS: { value: number | null; label: string }[] = [
  { value: 1, label: '1 km' },
  { value: 5, label: '5 km' },
  { value: 10, label: '10 km' },
  { value: 25, label: '25 km' },
  { value: null, label: 'Alle' },
];

const GENRE_GROUPS: { label: string; patterns: RegExp[] }[] = [
  { label: 'Pop & Rock', patterns: [/pop/i, /rock/i, /alternative/i, /indie/i, /singer/i, /schlager/i] },
  { label: 'Electronic', patterns: [/house/i, /techno/i, /trance/i, /electro/i, /dance/i, /rave/i, /dnb/i, /drum & bass/i, /deep house/i, /tech-house/i, /dj/i] },
  { label: 'Metal & Punk', patterns: [/metal/i, /punk/i, /hardcore/i, /screamo/i, /death metal/i, /black metal/i, /thrash/i] },
  { label: 'Hip-Hop & Rap', patterns: [/hip[-\s]?hop/i, /rap/i, /trap/i] },
  { label: 'Soul, Funk & Disco', patterns: [/soul/i, /funk/i, /disco/i, /r&b/i, /rnb/i] },
  { label: 'Jazz & Blues', patterns: [/jazz/i, /blues/i, /swing/i] },
  { label: 'Klassik & Chor', patterns: [/klassik/i, /chor/i, /orchester/i, /oper/i, /ballett/i] },
  { label: 'Party & Club', patterns: [/club/i, /party/i, /aftershow/i, /dancefloor/i] },
  { label: 'Comedy & Show', patterns: [/comedy/i, /kabarett/i, /show/i, /stand[-\s]?up/i] },
  { label: 'Markt, Bildung & Familie', patterns: [/markt/i, /flohmarkt/i, /dult/i, /bildung/i, /workshop/i, /yoga/i, /family/i, /kids/i, /community/i] },
];

const FREE_PRICE_PATTERN = /kostenlos|kostenfrei|gratis|umsonst|eintritt frei|free entry|\b0([.,]0+)?\s*€/i;

function isFreeEvent(priceInfo: string | null) {
  return priceInfo !== null && FREE_PRICE_PATTERN.test(priceInfo);
}

function normalizeGenreGroup(value: string | null) {
  const source = value?.trim();
  if (!source) return 'Sonstiges';

  const normalized = source.toLowerCase();
  const match = GENRE_GROUPS.find((group) =>
    group.patterns.some((pattern) => pattern.test(normalized))
  );

  return match ? match.label : 'Sonstiges';
}

function toggleInSet(current: string[], value: string): string[] {
  return current.includes(value)
    ? current.filter((v) => v !== value)
    : [...current, value];
}

export default function EventListScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ locations?: string }>();  
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [isOffline, setIsOffline] = useState(
    Platform.OS === 'web' && typeof navigator !== 'undefined' ? !navigator.onLine : false
  );
  const [search, setSearch] = useState('');
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedGenres, setSelectedGenres] = useState<string[]>([]);
  const [selectedLocations, setSelectedLocations] = useState<string[]>([]);
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');
  // Touch-Äquivalent zu Strg/Shift-Klick: mehrere einzelne Tage antippen
  // wählt sie alle aus (Ctrl-artig), ein zweiter Tap direkt nach dem ersten
  // füllt stattdessen automatisch den Zeitraum dazwischen (Shift-artig) —
  // siehe pickCalendarDay().
  const [selectedDates, setSelectedDates] = useState<string[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const [showFilterModal, setShowFilterModal] = useState(false);
  const [filterTab, setFilterTab] = useState<'category' | 'genre' | 'location'>('category');
  const [locationSearch, setLocationSearch] = useState('');
  const [selectedGroup, setSelectedGroup] = useState<Event[] | null>(null);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [locationStatus, setLocationStatus] = useState<'idle' | 'loading' | 'denied'>('idle');
  const [nearbyRadiusKm, setNearbyRadiusKm] = useState<number | null>(null);
  const { favorites, isFavorite, toggleFavorite } = useFavorites();
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [showFreeOnly, setShowFreeOnly] = useState(false);

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
    async function loadEvents() {
      const today = new Date().toISOString().slice(0, 10);

      const { data, error } = await supabase
        .from('events')
        .select('id, title, category, subcategory, organizer, address, description, source_url, image_url, price_info, sold_out, start_date, start_time, location_name, latitude, longitude')
        .gte('start_date', today)
        .is('duplicate_of', null)
        .order('start_date', { ascending: true })
        .limit(500);

      if (error) {
        console.error('Fehler beim Laden:', error);
      } else {
        setEvents(data ?? []);
      }
      setLoading(false);
    }

    loadEvents();
  }, []);

  useEffect(() => {
  if (params.locations) {
    setSelectedLocations(params.locations.split(','));
  }
}, [params.locations]);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const goOnline = () => setIsOffline(false);
    const goOffline = () => setIsOffline(true);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  const categories = useMemo(() => {
    const unique = new Set(events.map((e) => e.category).filter(Boolean));
    return Array.from(unique).sort() as string[];
  }, [events]);

  const genres = useMemo(() => {
    const unique = new Set(
      events.map((e) => normalizeGenreGroup(e.subcategory ?? e.category)).filter(Boolean)
    );
    return Array.from(unique).sort() as string[];
  }, [events]);

  const locations = useMemo(() => {
    const map = new Map<string, Set<string>>();
    events.forEach((e) => {
      const orig = e.location_name ?? 'Unbekannt';
      const key = canonicalizeVenue(orig);
      if (!map.has(key)) map.set(key, new Set());
      map.get(key)!.add(orig);
    });
    return Array.from(map.keys()).sort() as string[];
  }, [events]);

  const filteredLocationOptions = useMemo(() => {
    const query = locationSearch.toLowerCase();
    return locations.filter((loc) => loc.toLowerCase().includes(query));
  }, [locations, locationSearch]);

  const filteredEvents = useMemo(() => {
    const { from, to } = dateFilter === 'custom' ? { from: '', to: null } : getDateRange(dateFilter);

    return events.filter((e) => {
      const formattedDate = formatDate(e.start_date, e.start_time);
      const eventGenre = normalizeGenreGroup(e.subcategory ?? e.category);
      // Tippfehler-tolerant statt exaktem Teilstring — ein Wort in der
      // Suchanfrage muss nicht 1:1 vorkommen, kleine Abweichungen (z.B. "konzret"
      // statt "konzert") werden toleriert. Alle Felder zu einem Haystack
      // zusammenfassen statt einzeln zu prüfen, damit auch Suchbegriffe über
      // mehrere Felder hinweg (z.B. "backstage rock") funktionieren.
      const haystack = [
        e.title,
        e.location_name,
        e.category,
        e.subcategory,
        eventGenre,
        e.organizer,
        e.address,
        e.description,
        formattedDate,
        toGermanNumericDates(e.start_date),
      ]
        .filter(Boolean)
        .join(' ');
      const matchesSearch = fuzzyMatch(haystack, search);
      const matchesCategory =
        selectedCategories.length === 0 ||
        (e.category !== null && selectedCategories.includes(e.category));
      const matchesGenre =
        selectedGenres.length === 0 ||
        selectedGenres.includes(eventGenre);
      const eventCanonical = canonicalizeVenue(e.location_name);
      const matchesLocation =
        selectedLocations.length === 0 ||
        selectedLocations.includes(eventCanonical);
      const matchesDate =
        dateFilter === 'custom'
          ? selectedDates.includes(e.start_date)
          : e.start_date >= from && (to === null || e.start_date <= to);
      const matchesFavorite = !showFavoritesOnly || favorites.includes(e.id);
      const matchesFree = !showFreeOnly || isFreeEvent(e.price_info);
      return matchesSearch && matchesCategory && matchesGenre && matchesLocation && matchesDate && matchesFavorite && matchesFree;
    });
  }, [events, search, selectedCategories, selectedGenres, selectedLocations, dateFilter, selectedDates, showFavoritesOnly, favorites, showFreeOnly]);

  // Bündelt wiederkehrende Events (gleicher Titel + gleicher Ort, z.B. eine
  // wöchentliche Partyreihe) zu einer Gruppe. In der Liste wird nur der
  // nächste Termin gezeigt; ein Antippen öffnet bei mehreren Terminen eine
  // Übersicht aller künftigen Termine statt direkt zum Event zu springen.
  const eventGroups = useMemo(() => {
    const map = new Map<string, Event[]>();
    for (const e of filteredEvents) {
      const key = computeSeriesKey(e.title, e.location_name);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(e);
    }
    const sortKey = (e: Event) => `${e.start_date}T${e.start_time ?? '00:00'}`;
    const groups = Array.from(map.values()).map((evts) =>
      [...evts].sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
    );

    if (userLocation) {
      // Events ohne Koordinaten ans Ende, Rest nach Entfernung aufsteigend.
      const dist = (e: Event) =>
        e.latitude !== null && e.longitude !== null
          ? distanceKm(userLocation.lat, userLocation.lng, e.latitude, e.longitude)
          : Infinity;
      groups.sort((a, b) => dist(a[0]) - dist(b[0]));
      if (nearbyRadiusKm !== null) {
        // Events ohne Koordinaten (dist === Infinity) fallen bei aktivem
        // Umkreis automatisch raus, da ihre Entfernung nicht bestimmbar ist.
        return groups.filter((g) => dist(g[0]) <= nearbyRadiusKm);
      }
    } else {
      groups.sort((a, b) => sortKey(a[0]).localeCompare(sortKey(b[0])));
    }
    return groups;
  }, [filteredEvents, userLocation, nearbyRadiusKm]);

  function openCalendar() {
    const base = selectedDates[0] ? new Date(selectedDates[0]) : new Date();
    setCalendarMonth({ year: base.getFullYear(), month: base.getMonth() });
    setShowPicker(true);
  }

  // Touch-Äquivalent zu Strg/Shift-Klick (siehe selectedDates-State oben):
  // 1. Tap auf leerer Auswahl -> dieser eine Tag.
  // 2. Tap auf zweiten, anderen Tag direkt danach -> Zeitraum dazwischen
  //    wird komplett aufgefüllt (Shift-artig).
  // 3. Jeder weitere Tap schaltet den angetippten Tag einzeln an/aus
  //    (Strg-artig) — so lassen sich z.B. einzelne Tage aus einem Zeitraum
  //    wieder entfernen oder zusätzliche, nicht zusammenhängende Tage ergänzen.
  // Entspricht das Ergebnis exakt einem Schnellfilter (Heute, Morgen, Diese
  // Woche, Wochenende), wird dieser statt einer Custom-Auswahl aktiviert.
  function pickCalendarDay(date: Date) {
    const dateStr = toLocalDateStr(date);
    let next: string[];
    if (selectedDates.length === 0) {
      next = [dateStr];
    } else if (selectedDates.length === 1) {
      next = selectedDates[0] === dateStr ? [] : buildDateRangeArray(selectedDates[0], dateStr);
    } else {
      next = selectedDates.includes(dateStr)
        ? selectedDates.filter((d) => d !== dateStr)
        : [...selectedDates, dateStr].sort();
    }

    const quickFilter = matchesQuickFilter(next);
    if (quickFilter) {
      setSelectedDates([]);
      setDateFilter(quickFilter);
      if (next.length === 1) setShowPicker(false);
      return;
    }
    setSelectedDates(next);
    setDateFilter(next.length === 0 ? 'all' : 'custom');
  }

  function shiftCalendarMonth(delta: number) {
    setCalendarMonth((prev) => {
      const d = new Date(prev.year, prev.month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  }

  function customDateLabel() {
    if (selectedDates.length === 0) return '📅 Datum wählen';
    if (selectedDates.length === 1) {
      const [y, m, d] = selectedDates[0].split('-');
      return `📅 ${d}.${m}.${y}`;
    }
    const sorted = [...selectedDates].sort();
    const isContiguous = arraysEqual(sorted, buildDateRangeArray(sorted[0], sorted[sorted.length - 1]));
    if (isContiguous) {
      const [, m1, d1] = sorted[0].split('-');
      const [, m2, d2] = sorted[sorted.length - 1].split('-');
      return `📅 ${d1}.${m1}.–${d2}.${m2}.`;
    }
    return `📅 ${selectedDates.length} Tage`;
  }

  const contentFilterCount = selectedCategories.length + selectedGenres.length + selectedLocations.length;
  const hasAnyActiveFilter =
    search.trim() !== '' ||
    contentFilterCount > 0 ||
    dateFilter !== 'all' ||
    showFavoritesOnly ||
    showFreeOnly;

  function resetAllFilters() {
    setSearch('');
    setSelectedCategories([]);
    setSelectedGenres([]);
    setSelectedLocations([]);
    setDateFilter('all');
    setSelectedDates([]);
    setShowFavoritesOnly(false);
    setShowFreeOnly(false);
  }

  const activeFilterTabData =
    filterTab === 'category' ? categories : filterTab === 'genre' ? genres : filteredLocationOptions;
  const activeFilterTabSelected =
    filterTab === 'category' ? selectedCategories : filterTab === 'genre' ? selectedGenres : selectedLocations;
  const toggleActiveFilterTab = (value: string) => {
    if (filterTab === 'category') setSelectedCategories((prev) => toggleInSet(prev, value));
    else if (filterTab === 'genre') setSelectedGenres((prev) => toggleInSet(prev, value));
    else setSelectedLocations((prev) => toggleInSet(prev, value));
  };
  const resetActiveFilterTab = () => {
    if (filterTab === 'category') setSelectedCategories([]);
    else if (filterTab === 'genre') setSelectedGenres([]);
    else setSelectedLocations([]);
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator size="large" color="#fff" />
      </SafeAreaView>
    );
  }

  // Für die Hervorhebung im Kalender: welche Tage sind gerade aktiv,
  // unabhängig davon ob über einen Schnellfilter-Chip oder manuell im
  // Kalender ausgewählt.
  const activeDateSet =
    dateFilter === 'custom'
      ? selectedDates
      : dateFilter === 'all'
      ? []
      : (() => {
          const { from, to } = getDateRange(dateFilter);
          return buildDateRangeArray(from, to ?? from);
        })();

  const listHeader = (
    <>
      <LinearGradient
        colors={['#2a0a4a', '#12082e', '#000000']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.banner}
      >
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.header}>Vibe</Text>
            <Text style={styles.subheader}>Events in München</Text>
          </View>
          <TouchableOpacity style={styles.mapButton} onPress={() => router.push('/map')}>
            <Text style={styles.mapButtonText}>🗺️ Karte</Text>
          </TouchableOpacity>
        </View>
      </LinearGradient>

      {isOffline && (
        <View style={styles.offlineBanner}>
          <Text style={styles.offlineBannerText}>
            📴 Offline — zeige zuletzt geladene Events
          </Text>
        </View>
      )}

      <View style={[styles.stickyControls, Platform.OS === 'web' && styles.stickyControlsWeb]}>
      <View style={styles.searchWrap}>
        <TextInput
          style={[styles.search, styles.searchInput]}
          placeholder="Event, Ort, Genre oder Datum suchen..."
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

      <View style={styles.controlRow}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.dateScrollContent}
          style={styles.dateScroll}
        >
          {/* Alle Chips/Buttons in EINER scrollbaren Reihe statt Datum-Chips
              (flex:1) neben mehreren fixbreiten Buttons als Geschwister —
              auf schmalen Handy-Bildschirmen quetschte das die Datum-Chips
              auf ~0 Breite und schob den letzten Button (Nähe) komplett aus
              dem sichtbaren Bereich, da die äußere Row selbst nicht scrollte. */}
          {DATE_FILTERS.map((f) => (
            <TouchableOpacity
              key={f.key}
              style={[styles.filterChip, dateFilter === f.key && styles.filterChipActive]}
              onPress={() => {
                setDateFilter(f.key);
                setSelectedDates([]);
              }}
            >
              <Text
                style={[
                  styles.filterChipText,
                  dateFilter === f.key && styles.filterChipTextActive,
                ]}
              >
                {f.label}
              </Text>
            </TouchableOpacity>
          ))}

          <TouchableOpacity
            style={[styles.filterChip, dateFilter === 'custom' && styles.filterChipActive]}
            onPress={openCalendar}
          >
            <Text
              style={[
                styles.filterChipText,
                dateFilter === 'custom' && styles.filterChipTextActive,
              ]}
            >
              {customDateLabel()}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.filterButton, contentFilterCount > 0 && styles.filterChipActive]}
            onPress={() => setShowFilterModal(true)}
          >
            <Text style={[styles.filterButtonText, contentFilterCount > 0 && styles.filterChipTextActive]}>
              ⚙️ Filter{contentFilterCount > 0 ? ` (${contentFilterCount})` : ''}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.filterButton, styles.nearbyButton, showFavoritesOnly && styles.filterChipActive]}
            onPress={() => setShowFavoritesOnly((v) => !v)}
          >
            <Text style={[styles.filterButtonText, showFavoritesOnly && styles.filterChipTextActive]}>
              {showFavoritesOnly ? '❤️' : '🤍'} Favoriten
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.filterButton, styles.nearbyButton, showFreeOnly && styles.filterChipActive]}
            onPress={() => setShowFreeOnly((v) => !v)}
          >
            <Text style={[styles.filterButtonText, showFreeOnly && styles.filterChipTextActive]}>
              🆓 Kostenlos
            </Text>
          </TouchableOpacity>

          {Platform.OS === 'web' && (
            <TouchableOpacity
              style={[styles.filterButton, styles.nearbyButton, userLocation && styles.filterChipActive]}
              onPress={toggleNearby}
            >
              <Text style={[styles.filterButtonText, userLocation && styles.filterChipTextActive]}>
                {locationStatus === 'loading' ? '📍 ...' : '📍 Nähe'}
              </Text>
            </TouchableOpacity>
          )}
        </ScrollView>
      </View>

      <View style={styles.resultCountRow}>
        <Text style={styles.resultCount}>
          {eventGroups.length} {eventGroups.length === 1 ? 'Event' : 'Events'} gefunden
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
          <Text style={styles.radiusLabel}>Umkreis:</Text>
          {RADIUS_OPTIONS.map((opt) => (
            <TouchableOpacity
              key={opt.label}
              style={[styles.radiusChip, nearbyRadiusKm === opt.value && styles.radiusChipActive]}
              onPress={() => setNearbyRadiusKm(opt.value)}
            >
              <Text
                style={[
                  styles.radiusChipText,
                  nearbyRadiusKm === opt.value && styles.radiusChipTextActive,
                ]}
              >
                {opt.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      <Modal
        visible={showPicker}
        transparent
        animationType="fade"
        onRequestClose={() => setShowPicker(false)}
      >
        <TouchableOpacity
          style={styles.calendarBackdrop}
          activeOpacity={1}
          onPress={() => setShowPicker(false)}
        >
          <TouchableOpacity activeOpacity={1} style={styles.calendarBox} onPress={() => {}}>
            <View style={styles.calendarHeader}>
              <TouchableOpacity onPress={() => shiftCalendarMonth(-1)} style={styles.calendarNavBtn}>
                <Text style={styles.calendarNavText}>‹</Text>
              </TouchableOpacity>
              <Text style={styles.calendarTitle}>
                {MONTH_LABELS[calendarMonth.month]} {calendarMonth.year}
              </Text>
              <TouchableOpacity onPress={() => shiftCalendarMonth(1)} style={styles.calendarNavBtn}>
                <Text style={styles.calendarNavText}>›</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.calendarWeekRow}>
              {WEEKDAY_LABELS.map((w) => (
                <Text key={w} style={styles.calendarWeekLabel}>{w}</Text>
              ))}
            </View>

            <View style={styles.calendarGrid}>
              {getMonthMatrix(calendarMonth.year, calendarMonth.month).map(({ date, inMonth }) => {
                const dateStr = toLocalDateStr(date);
                const isToday = dateStr === toLocalDateStr(new Date());
                const isSelected = activeDateSet.includes(dateStr);
                return (
                  <TouchableOpacity
                    key={dateStr}
                    style={[
                      styles.calendarDay,
                      isSelected && styles.calendarDaySelected,
                      isToday && !isSelected && styles.calendarDayToday,
                    ]}
                    onPress={() => pickCalendarDay(date)}
                  >
                    <Text
                      style={[
                        styles.calendarDayText,
                        !inMonth && styles.calendarDayTextMuted,
                        isSelected && styles.calendarDayTextSelected,
                      ]}
                    >
                      {date.getDate()}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={styles.calendarFooterRow}>
              {activeDateSet.length > 0 && (
                <TouchableOpacity
                  style={styles.calendarClearBtn}
                  onPress={() => {
                    setSelectedDates([]);
                    setDateFilter('all');
                    setShowPicker(false);
                  }}
                >
                  <Text style={styles.calendarClearText}>Zurücksetzen</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={styles.calendarDoneBtn}
                onPress={() => setShowPicker(false)}
              >
                <Text style={styles.calendarDoneText}>Fertig</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {contentFilterCount > 0 && (
        <View style={styles.activePillsWrap}>
          {selectedCategories.map((c) => (
            <TouchableOpacity
              key={`cat-${c}`}
              style={styles.activePill}
              onPress={() => setSelectedCategories((prev) => prev.filter((v) => v !== c))}
            >
              <Text style={styles.activePillText}>{c} ✕</Text>
            </TouchableOpacity>
          ))}
          {selectedGenres.map((g) => (
            <TouchableOpacity
              key={`genre-${g}`}
              style={styles.activePill}
              onPress={() => setSelectedGenres((prev) => prev.filter((v) => v !== g))}
            >
              <Text style={styles.activePillText}>{g} ✕</Text>
            </TouchableOpacity>
          ))}
          {selectedLocations.map((l) => (
            <TouchableOpacity
              key={`loc-${l}`}
              style={styles.activePill}
              onPress={() => setSelectedLocations((prev) => prev.filter((v) => v !== l))}
            >
              <Text style={styles.activePillText}>📍 {l} ✕</Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity
            style={styles.activePillResetAll}
            onPress={() => {
              setSelectedCategories([]);
              setSelectedGenres([]);
              setSelectedLocations([]);
            }}
          >
            <Text style={styles.activePillResetAllText}>Alle zurücksetzen</Text>
          </TouchableOpacity>
        </View>
      )}
      </View>
    </>
  );

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        data={eventGroups}
        keyExtractor={(group) => group[0].id}
        contentContainerStyle={styles.list}
        ListHeaderComponent={listHeader}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={<Text style={styles.empty}>Keine Events gefunden.</Text>}
        renderItem={({ item: group }) => {
          const item = group[0];
          const hasMore = group.length > 1;
          return (
            <TouchableOpacity
              style={styles.card}
              onPress={() =>
                hasMore ? setSelectedGroup(group) : router.push(`/event/${item.id}`)
              }
            >
              <TouchableOpacity
                style={styles.favoriteBtn}
                onPress={(e) => {
                  e.stopPropagation();
                  toggleFavorite(item.id);
                }}
              >
                <Text style={styles.favoriteBtnText}>{isFavorite(item.id) ? '❤️' : '🤍'}</Text>
              </TouchableOpacity>
              {item.image_url ? (
                <Image source={{ uri: item.image_url }} style={styles.cardThumb} />
              ) : null}
              <View style={styles.cardBody}>
                <View style={styles.badgeRow}>
                  {item.category && <Text style={styles.badge}>{item.category}</Text>}
                  {hasMore && (
                    <Text style={styles.seriesBadge}>🔁 {group.length} Termine</Text>
                  )}
                  {item.sold_out === true && <Text style={styles.soldOutBadge}>Ausverkauft</Text>}
                </View>
                <Text style={styles.title}>{item.title}</Text>
                <Text style={styles.meta}>
                  {hasMore ? 'Nächster Termin: ' : ''}
                  {formatDate(item.start_date, item.start_time)}
                  {item.location_name ? ` · ${item.location_name}` : ''}
                  {userLocation && item.latitude != null && item.longitude != null
                    ? ` · ${formatDistance(distanceKm(userLocation.lat, userLocation.lng, item.latitude, item.longitude))}`
                    : ''}
                </Text>
                {item.subcategory ? <Text style={styles.subMeta}>{item.subcategory}</Text> : null}
                {item.price_info ? <Text style={styles.priceMeta}>{item.price_info}</Text> : null}
              </View>
            </TouchableOpacity>
          );
        }}
      />

      {/* Kombiniertes Filter-Modal: Kategorie/Genre/Ort als Tabs statt drei
          separater, gleich aussehender Buttons+Modals. */}
      <Modal
        visible={showFilterModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowFilterModal(false)}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setShowFilterModal(false)}
        >
          <TouchableOpacity activeOpacity={1} style={styles.modalCard} onPress={() => {}}>
            <View style={styles.modalHeaderRow}>
              <Text style={styles.modalTitle}>Filter</Text>
              {activeFilterTabSelected.length > 0 && (
                <TouchableOpacity onPress={resetActiveFilterTab}>
                  <Text style={styles.modalResetLink}>Zurücksetzen</Text>
                </TouchableOpacity>
              )}
            </View>

            <View style={styles.filterTabRow}>
              {(
                [
                  { key: 'category' as const, label: 'Kategorie', count: selectedCategories.length },
                  { key: 'genre' as const, label: 'Genre', count: selectedGenres.length },
                  { key: 'location' as const, label: 'Ort', count: selectedLocations.length },
                ]
              ).map((tab) => (
                <TouchableOpacity
                  key={tab.key}
                  style={[styles.filterTab, filterTab === tab.key && styles.filterTabActive]}
                  onPress={() => setFilterTab(tab.key)}
                >
                  <Text style={[styles.filterTabText, filterTab === tab.key && styles.filterTabTextActive]}>
                    {tab.label}{tab.count > 0 ? ` (${tab.count})` : ''}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {filterTab === 'location' && (
              <TextInput
                style={[styles.search, styles.locationSearchInput]}
                placeholder="Ort suchen..."
                placeholderTextColor="#666"
                value={locationSearch}
                onChangeText={setLocationSearch}
              />
            )}

            <FlatList
              data={activeFilterTabData}
              keyExtractor={(item) => item}
              renderItem={({ item }) => {
                const isActive = activeFilterTabSelected.includes(item);
                return (
                  <TouchableOpacity
                    style={[styles.modalRow, isActive && styles.modalRowActive]}
                    onPress={() => toggleActiveFilterTab(item)}
                  >
                    <Text style={[styles.modalRowText, isActive && styles.modalRowTextActive]}>
                      {isActive ? '✓ ' : ''}
                      {item}
                    </Text>
                  </TouchableOpacity>
                );
              }}
            />
            <View style={styles.modalButtonRow}>
              <TouchableOpacity
                style={styles.modalCloseButton}
                onPress={() => {
                  setShowFilterModal(false);
                  setLocationSearch('');
                }}
              >
                <Text style={styles.modalCloseButtonText}>Fertig</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Alle Termine einer wiederkehrenden Event-Serie */}
      <Modal
        visible={selectedGroup !== null}
        animationType="slide"
        transparent
        onRequestClose={() => setSelectedGroup(null)}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setSelectedGroup(null)}
        >
          <TouchableOpacity activeOpacity={1} style={styles.modalCard} onPress={() => {}}>
            <Text style={styles.modalTitle}>{selectedGroup?.[0]?.title}</Text>
            <Text style={styles.modalSubtitle}>
              {selectedGroup?.length} Termine
              {selectedGroup?.[0]?.location_name ? ` · ${selectedGroup[0].location_name}` : ''}
            </Text>
            <FlatList
              data={selectedGroup?.slice(0, 12) ?? []}
              keyExtractor={(item) => item.id}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.modalRow}
                  onPress={() => {
                    setSelectedGroup(null);
                    router.push(`/event/${item.id}`);
                  }}
                >
                  <Text style={styles.modalRowText}>{formatDate(item.start_date, item.start_time)}</Text>
                </TouchableOpacity>
              )}
              ListFooterComponent={
                selectedGroup && selectedGroup.length > 12 ? (
                  <Text style={styles.modalFooterHint}>
                    + {selectedGroup.length - 12} weitere Termine (auf der Quellseite sichtbar)
                  </Text>
                ) : null
              }
            />
            {selectedGroup && selectedGroup.length > 1 && (
              <TouchableOpacity
                style={styles.modalSecondaryButton}
                onPress={() =>
                  addEventsToCalendar(
                    selectedGroup.map((ev) => ({
                      id: ev.id,
                      title: ev.title,
                      start_date: ev.start_date,
                      start_time: ev.start_time,
                      location_name: ev.location_name,
                    }))
                  )
                }
              >
                <Text style={styles.modalSecondaryButtonText}>
                  📅 Alle {selectedGroup.length} Termine in Kalender speichern
                </Text>
              </TouchableOpacity>
            )}
            <View style={styles.modalButtonRow}>
              <TouchableOpacity
                style={styles.modalCloseButton}
                onPress={() => setSelectedGroup(null)}
              >
                <Text style={styles.modalCloseButtonText}>Schließen</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' },
  banner: {
    borderBottomLeftRadius: 28,
    borderBottomRightRadius: 28,
    paddingBottom: 22,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 20,
  },
  header: { fontSize: 30, fontWeight: '800', color: '#fff' },
  subheader: { fontSize: 14, color: '#cbb8f0' },
  offlineBanner: {
    backgroundColor: '#3a2a00',
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  offlineBannerText: { color: '#f2c94c', fontSize: 12, fontWeight: '600', textAlign: 'center' },
  stickyControls: { paddingTop: 12 },
  // position:"sticky" reicht auf Web als reines CSS aus (React Native Web
  // gibt das 1:1 durch) — bleibt beim Scrollen der Liste am oberen Rand
  // hängen, ohne wie ein position:"fixed"-Sibling mit der iOS-Tastatur zu
  // kollidieren (siehe Kommentar zum ListHeaderComponent weiter oben), weil
  // es Teil des normalen Scroll-Flows der Liste bleibt statt eigenständig
  // positioniert zu sein. Nativ absichtlich nicht aktiviert (dort weniger
  // zuverlässig unterstützt und PWA/Web ist der primäre Vertriebsweg).
  stickyControlsWeb: {
    position: 'sticky' as any,
    top: 0,
    zIndex: 20,
    backgroundColor: '#000',
  },
  mapButton: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  mapButtonText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  search: {
    backgroundColor: '#141414',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#fff',
    // Mind. 16px, sonst zoomt iOS Safari beim Fokussieren automatisch rein
    // und das Layout muss danach manuell zurückgezoomt werden.
    fontSize: 16,
  },
  searchWrap: {
    marginHorizontal: 16,
    marginTop: 16,
    marginBottom: 14,
    position: 'relative',
    justifyContent: 'center',
  },
  searchInput: { paddingRight: 38 },
  locationSearchInput: { marginHorizontal: 16, marginBottom: 10 },
  searchClearBtn: {
    position: 'absolute',
    right: 6,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  searchClearBtnText: { color: '#888', fontSize: 15, fontWeight: '700' },
  controlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 16,
    marginBottom: 8,
  },
  dateScroll: { flex: 1 },
  dateScrollContent: { paddingRight: 8, alignItems: 'center' },
  filterChip: {
    backgroundColor: '#141414',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginRight: 8,
  },
  filterButton: {
    backgroundColor: '#141414',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginRight: 16,
  },
  filterButtonText: { color: '#999', fontSize: 13, fontWeight: '600' },
  nearbyButton: { marginRight: 16 },
  locationHint: {
    color: '#888',
    fontSize: 12,
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  resultCountRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  resultCount: { color: '#666', fontSize: 12 },
  resultCountResetLink: {
    color: '#888',
    fontSize: 12,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
  radiusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    marginBottom: 8,
    flexWrap: 'wrap',
    gap: 6,
  },
  radiusLabel: { color: '#888', fontSize: 12, marginRight: 4 },
  radiusChip: {
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  radiusChipActive: { backgroundColor: '#0af', borderColor: '#0af' },
  radiusChipText: { color: '#999', fontSize: 12, fontWeight: '600' },
  radiusChipTextActive: { color: '#000' },
  calendarBackdrop: {
    flex: 1,
    backgroundColor: '#000a',
    justifyContent: 'center',
    alignItems: 'center',
  },
  calendarBox: {
    backgroundColor: '#141414',
    borderRadius: 16,
    padding: 16,
    width: 320,
    maxWidth: '90%',
  },
  calendarHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  calendarNavBtn: {
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  calendarNavText: { color: '#0af', fontSize: 20, fontWeight: '700' },
  calendarTitle: { color: '#fff', fontSize: 15, fontWeight: '700' },
  calendarWeekRow: {
    flexDirection: 'row',
    marginBottom: 4,
  },
  calendarWeekLabel: {
    flex: 1,
    textAlign: 'center',
    color: '#666',
    fontSize: 12,
    fontWeight: '600',
  },
  calendarGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  calendarDay: {
    width: `${100 / 7}%`,
    aspectRatio: 1,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 8,
    marginVertical: 1,
  },
  calendarDaySelected: { backgroundColor: '#0af' },
  calendarDayToday: {
    borderWidth: 1,
    borderColor: '#0af',
  },
  calendarDayText: { color: '#eee', fontSize: 14 },
  calendarDayTextMuted: { color: '#444' },
  calendarDayTextSelected: { color: '#000', fontWeight: '700' },
  calendarFooterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginTop: 12,
    gap: 16,
  },
  calendarClearBtn: {
    paddingVertical: 10,
  },
  calendarClearText: { color: '#888', fontSize: 13, textDecorationLine: 'underline' },
  calendarDoneBtn: {
    backgroundColor: '#0af',
    borderRadius: 10,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  calendarDoneText: { color: '#000', fontSize: 14, fontWeight: '700' },
  filterChipActive: { backgroundColor: '#0af' },
  filterChipText: { color: '#999', fontSize: 13, fontWeight: '600' },
  filterChipTextActive: { color: '#000' },
  activePillsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 16,
    marginBottom: 8,
    gap: 8,
  },
  activePill: {
    backgroundColor: '#0af2',
    borderWidth: 1,
    borderColor: '#0af',
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  activePillText: { color: '#0af', fontSize: 12, fontWeight: '600' },
  activePillResetAll: {
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  activePillResetAllText: { color: '#666', fontSize: 12, fontWeight: '600', textDecorationLine: 'underline' },
  filterTabRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    marginBottom: 8,
    gap: 8,
  },
  filterTab: {
    flex: 1,
    backgroundColor: '#141414',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  filterTabActive: { backgroundColor: '#0af' },
  filterTabText: { color: '#999', fontSize: 13, fontWeight: '600' },
  filterTabTextActive: { color: '#000' },
  list: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 24 },
  empty: { color: '#666', textAlign: 'center', marginTop: 40 },
  card: {
    flexDirection: 'row',
    backgroundColor: '#141414',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    padding: 14,
    marginBottom: 10,
    position: 'relative',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 3,
  },
  favoriteBtn: {
    position: 'absolute',
    top: 8,
    right: 8,
    padding: 6,
    zIndex: 1,
  },
  favoriteBtnText: { fontSize: 16 },
  cardThumb: {
    width: 72,
    height: 72,
    borderRadius: 12,
    marginRight: 12,
    backgroundColor: '#1a1a1a',
  },
  cardBody: { flex: 1 },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    marginBottom: 6,
  },
  badge: {
    fontSize: 11,
    fontWeight: '700',
    color: '#5fd4ff',
    textTransform: 'uppercase',
    backgroundColor: 'rgba(0,170,255,0.14)',
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 3,
    marginRight: 6,
    overflow: 'hidden',
  },
  seriesBadge: {
    fontSize: 11,
    fontWeight: '700',
    color: '#999',
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  title: { fontSize: 16, fontWeight: '700', color: '#fff', marginBottom: 4, letterSpacing: 0.1 },
  meta: { fontSize: 13, color: '#999' },
  subMeta: { fontSize: 12, color: '#666', marginTop: 2 },
  priceMeta: {
    fontSize: 12,
    color: '#7cd992',
    marginTop: 6,
    fontWeight: '700',
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(124,217,146,0.12)',
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 3,
    overflow: 'hidden',
  },
  soldOutBadge: {
    fontSize: 11,
    fontWeight: '700',
    color: '#ff6b6b',
    backgroundColor: '#ff6b6b22',
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: '#0a0a0a',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 16,
    maxHeight: '75%',
  },
  modalHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  modalTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
    flexShrink: 1,
  },
  modalResetLink: {
    color: '#0af',
    fontSize: 13,
    fontWeight: '600',
  },
  modalSubtitle: {
    color: '#888',
    fontSize: 13,
    paddingHorizontal: 16,
    marginBottom: 10,
  },
  modalFooterHint: {
    color: '#666',
    fontSize: 12,
    textAlign: 'center',
    paddingVertical: 14,
  },
  modalRow: {
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  modalRowActive: { backgroundColor: '#0af1' },
  modalRowText: { color: '#ccc', fontSize: 15 },
  modalRowTextActive: { color: '#0af', fontWeight: '700' },
  modalButtonRow: {
    flexDirection: 'row',
    gap: 10,
    margin: 16,
  },
  modalCloseButton: {
    flex: 1,
    backgroundColor: '#0af',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  modalCloseButtonText: { color: '#000', fontWeight: '700' },
  modalSecondaryButton: {
    backgroundColor: '#141414',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 10,
  },
  modalSecondaryButtonText: { color: '#fff', fontWeight: '600', fontSize: 13 },
});