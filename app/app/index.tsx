import { useEffect, useMemo, useRef, useState } from 'react';
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
import { Ionicons } from '@expo/vector-icons';
import BottomTabBar from '../components/BottomTabBar';
import { supabase } from '../lib/supabase';
import { canonicalizeVenue } from '../lib/venue';
import { computeSeriesKey } from '../lib/seriesKey';
import { setFilteredEventsForMap } from '../lib/mapFilterCache';
import { fuzzyMatch } from '../lib/fuzzySearch';
import { addEventsToCalendar } from '../lib/calendar';
import { useFavorites } from '../lib/favorites';
import { useFollowedOrganizers } from '../lib/followedOrganizers';
import { useReminderSettings, REMINDER_OFFSET_OPTIONS } from '../lib/reminderSettings';
import {
  isPushSupported,
  isPushEnabled,
  enablePushNotifications,
  disablePushNotifications,
  syncFavoritesToServer,
  syncFiltersToServer,
  syncReminderSettingsToServer,
} from '../lib/pushNotifications';

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
  end_date: string | null;
  location_name: string | null;
  latitude: number | null;
  longitude: number | null;
};

// Zeilentyp für die Haupt-FlatList: entweder das "Empfohlen"-Karussell (ganz
// oben, einmalig) oder eine normale Event-Serie. So bleibt das Karussell Teil
// des normalen Scroll-Inhalts (scrollt mit weg) statt im gepinnten Header zu
// hängen, wo dauerhaft Bildschirmfläche verloren ginge.
type ListRow =
  | { kind: 'banner' }
  | { kind: 'featured'; events: Event[] }
  | { kind: 'group'; group: Event[] };

// Modul-level statt useState-Default: bleibt über einen Tab-Wechsel hinweg
// erhalten, obwohl der Screen bei jedem Wechsel zwischen Events/Bars/
// Restaurants komplett neu gemountet wird (eigener Stack.Screen pro Tab,
// kein Tabs-Navigator, der Screens am Leben hält). Ohne das flackerte bei
// jedem Zurückwechseln zu Events wieder das Lade-Skeleton auf und alle
// 6000+ Events wurden erneut über mehrere Seiten von Supabase geholt, obwohl
// sie Sekunden zuvor schon da waren — spürbar lange Wartezeit beim
// Tab-Switching. Mit Cache: sofort der zuletzt geladene Stand sichtbar,
// im Hintergrund läuft trotzdem ein stiller Refresh (siehe loadEvents).
let eventsCache: Event[] | null = null;

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

// Für Mehrtages-Events (Ausstellungen, Dulten etc.) den Laufzeitraum als
// "– bis DD.MM." anhängen, wenn end_date gesetzt ist und vom Starttag abweicht.
function formatEndDateSuffix(startDate: string, endDate: string | null): string {
  if (!endDate || endDate === startDate) return '';
  const [, month, day] = endDate.split('-');
  return ` – bis ${day}.${month}.`;
}

// "YYYY-MM-DD" -> "DD.MM." und "DD.MM.YYYY", damit die Suche auch das in
// Deutschland übliche numerische Format findet (formatDate() liefert nur
// den ausgeschriebenen Wochentag/Monat, z.B. "Di., 25. Aug.", worin "25.08"
// nicht als Teilstring vorkommt). Zusätzlich die ungepolsterten Varianten
// ("5.8." statt nur "05.08.") — beim Tippen lässt man führende Nullen bei
// Tag/Monat oft weg, und fuzzyMatch() behandelt "5.8" als ein Token (der
// Punkt trennt nicht wie ein Leerzeichen), das ohne diese Variante nie einen
// exakten Teilstring-Treffer in "05.08." findet.
function toGermanNumericDates(dateStr: string): string {
  const [year, month, day] = dateStr.split('-');
  if (!year || !month || !day) return '';
  const unpaddedDay = String(Number(day));
  const unpaddedMonth = String(Number(month));
  const variants = new Set([
    `${day}.${month}.`,
    `${day}.${month}.${year}`,
    `${unpaddedDay}.${unpaddedMonth}.`,
    `${unpaddedDay}.${unpaddedMonth}.${year}`,
  ]);
  return [...variants].join(' ');
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

// Feste Auswahl-Chips statt eines <input type="range">-Sliders: ein
// kontinuierlicher Slider für 1-25km-Einzelschritte war auf dem Handy kaum
// präzise zu bedienen (per Nutzer-Feedback gemeldet) — dieselben Chips wie
// beim Datumsfilter sind mit dem Daumen deutlich zuverlässiger zu treffen
// als ein schmaler Schieberegler.
const RADIUS_PRESETS_KM: (number | null)[] = [null, 1, 2, 5, 10, 25];

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
  const params = useLocalSearchParams<{ locations?: string; search?: string }>();
  const [events, setEvents] = useState<Event[]>(() => eventsCache ?? []);
  const [loading, setLoading] = useState(() => eventsCache === null);
  const [refreshing, setRefreshing] = useState(false);
  const [showBackToTop, setShowBackToTop] = useState(false);
  const listRef = useRef<FlatList<ListRow>>(null);
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
  const { followedOrganizers } = useFollowedOrganizers();
  const { offsetsMinutes: reminderOffsets, toggleOffset: toggleReminderOffset } = useReminderSettings();
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [showFreeOnly, setShowFreeOnly] = useState(false);
  const [showMultiDayOnly, setShowMultiDayOnly] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [showReminderModal, setShowReminderModal] = useState(false);

  useEffect(() => {
    if (!isPushSupported()) return;
    isPushEnabled().then(setPushEnabled);
  }, []);

  // Favoriten und inhaltliche Filter (Kategorie/Genre/Ort) laufend zu
  // Supabase syncen, solange Push aktiv ist — der Sender (collectors/
  // notifications) prüft periodisch dagegen, welche Erinnerungen/Matches
  // fällig sind. Kein Sync, solange Push aus ist, um unnötige Requests zu
  // vermeiden.
  useEffect(() => {
    if (!pushEnabled) return;
    syncFavoritesToServer(favorites);
  }, [pushEnabled, favorites]);

  useEffect(() => {
    if (!pushEnabled) return;
    syncFiltersToServer({
      categories: selectedCategories,
      genres: selectedGenres,
      locations: selectedLocations,
      organizers: followedOrganizers,
    });
  }, [pushEnabled, selectedCategories, selectedGenres, selectedLocations, followedOrganizers]);

  useEffect(() => {
    if (!pushEnabled) return;
    syncReminderSettingsToServer(reminderOffsets);
  }, [pushEnabled, reminderOffsets]);

  async function togglePush() {
    if (pushBusy) return;
    setPushBusy(true);
    try {
      if (pushEnabled) {
        await disablePushNotifications();
        setPushEnabled(false);
      } else {
        const result = await enablePushNotifications();
        if (result.ok) {
          setPushEnabled(true);
        } else if (typeof window !== 'undefined') {
          window.alert(result.error);
        }
      }
    } finally {
      setPushBusy(false);
    }
  }

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
  async function loadEvents(isRefresh = false) {
    if (isRefresh) setRefreshing(true);
    try {
      const today = new Date().toISOString().slice(0, 10);
      const columns =
        'id, title, category, subcategory, organizer, address, description, source_url, image_url, price_info, sold_out, start_date, start_time, end_date, location_name, latitude, longitude';
      // Mehrtägige Events (end_date gesetzt) sollen sichtbar bleiben,
      // solange sie noch laufen — nicht nur bis zu ihrem Starttag.
      const upcomingFilter = `start_date.gte.${today},end_date.gte.${today}`;

      // Supabase deckelt jede einzelne Anfrage serverseitig auf ein Projekt-
      // Limit (aktuell 1000 Zeilen) — unabhängig vom angeforderten .limit().
      // Mit dem erweiterten eventim-Collector (ganz München, 180 Tage) sind
      // es inzwischen 6000+ kommende Events; ein einzelnes .limit(500) kappte
      // die sortierte Liste schon nach etwa einer Woche, alles danach
      // (z.B. ein Konzert erst im Oktober) war unauffindbar, ohne dass
      // irgendwo ein Fehler sichtbar wurde. Erst zählen, dann seitenweise
      // parallel nachladen. Sekundäres order('id') macht die Sortierung über
      // mehrere Seiten hinweg deterministisch — sonst könnten Events mit
      // exakt gleichem start_date an einer Seitengrenze doppelt auftauchen
      // oder fehlen, da Postgres bei Gleichstand sonst keine stabile
      // Reihenfolge garantiert.
      const pageSize = 1000;
      const { count, error: countError } = await supabase
        .from('events')
        .select('id', { count: 'exact', head: true })
        .or(upcomingFilter)
        .is('duplicate_of', null);

      if (countError || count == null) {
        console.error('Fehler beim Zählen:', countError);
        return;
      }

      const pageCount = Math.max(1, Math.ceil(count / pageSize));
      const pages = await Promise.all(
        Array.from({ length: pageCount }, (_, i) =>
          supabase
            .from('events')
            .select(columns)
            .or(upcomingFilter)
            .is('duplicate_of', null)
            .order('start_date', { ascending: true })
            .order('id', { ascending: true })
            .range(i * pageSize, i * pageSize + pageSize - 1)
        )
      );

      const firstError = pages.find((p) => p.error)?.error;
      if (firstError) {
        console.error('Fehler beim Laden:', firstError);
      } else {
        const loaded = pages.flatMap((p) => p.data ?? []);
        eventsCache = loaded;
        setEvents(loaded);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    loadEvents();
  }, []);

  useEffect(() => {
  if (params.locations) {
    setSelectedLocations(params.locations.split(','));
  }
}, [params.locations]);

  // Von der Event-Detailseite aus verlinkt ("Weitere Events von X", nach dem
  // Vorbild von Posh's "Hosted by · More events") — befüllt einfach das
  // bestehende Suchfeld statt eines eigenen Organizer-Filters, da der
  // Haystack organizer schon durchsucht (siehe fuzzyMatch weiter unten).
  useEffect(() => {
    if (params.search) {
      setSearch(params.search);
    }
  }, [params.search]);

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

  // Teure, pro-Event aber unveränderliche Ableitungen (Datum formatieren,
  // Genre-Regex-Abgleich, Venue-Kanonisierung, Haystack-String bauen) nur
  // einmal berechnen, wenn sich events ändert — nicht bei jedem Tastendruck
  // im Suchfeld oder jedem Filter-Toggle neu. Bei 500 Events fiel das nicht
  // auf, bei 6000+ (seit eventim ganz München abdeckt) machte genau das die
  // Filterung spürbar ruckelig, weil filteredEvents vorher bei jeder
  // Abhängigkeitsänderung diese Arbeit für die komplette Liste wiederholte.
  const enrichedEvents = useMemo(
    () =>
      events.map((e) => {
        const formattedDate = formatDate(e.start_date, e.start_time);
        const eventGenre = normalizeGenreGroup(e.subcategory ?? e.category);
        const eventCanonicalLocation = canonicalizeVenue(e.location_name);
        // Tippfehler-tolerant statt exaktem Teilstring — ein Wort in der
        // Suchanfrage muss nicht 1:1 vorkommen, kleine Abweichungen (z.B.
        // "konzret" statt "konzert") werden toleriert. Alle Felder zu einem
        // Haystack zusammenfassen statt einzeln zu prüfen, damit auch
        // Suchbegriffe über mehrere Felder hinweg (z.B. "backstage rock")
        // funktionieren.
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
        return { ...e, formattedDate, eventGenre, eventCanonicalLocation, haystack };
      }),
    [events]
  );

  const categories = useMemo(() => {
    const unique = new Set(events.map((e) => e.category).filter(Boolean));
    return Array.from(unique).sort() as string[];
  }, [events]);

  const genres = useMemo(() => {
    const unique = new Set(enrichedEvents.map((e) => e.eventGenre).filter(Boolean));
    return Array.from(unique).sort() as string[];
  }, [enrichedEvents]);

  const locations = useMemo(() => {
    const map = new Map<string, Set<string>>();
    enrichedEvents.forEach((e) => {
      const orig = e.location_name ?? 'Unbekannt';
      if (!map.has(e.eventCanonicalLocation)) map.set(e.eventCanonicalLocation, new Set());
      map.get(e.eventCanonicalLocation)!.add(orig);
    });
    return Array.from(map.keys()).sort() as string[];
  }, [enrichedEvents]);

  const filteredLocationOptions = useMemo(() => {
    const query = locationSearch.toLowerCase();
    return locations.filter((loc) => loc.toLowerCase().includes(query));
  }, [locations, locationSearch]);

  // Kurze Verzögerung, bevor eine neue Sucheingabe tatsächlich die komplette
  // Liste neu filtert — das Textfeld selbst (value={search}) bleibt sofort
  // responsiv, nur die teure Filterung über alle Events wartet, bis kurz
  // nichts mehr getippt wurde, statt bei jedem einzelnen Zeichen zu laufen.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 200);
    return () => clearTimeout(timer);
  }, [search]);

  const filteredEvents = useMemo(() => {
    const { from, to } = dateFilter === 'custom' ? { from: '', to: null } : getDateRange(dateFilter);

    return enrichedEvents.filter((e) => {
      const matchesSearch = fuzzyMatch(e.haystack, debouncedSearch);
      const matchesCategory =
        selectedCategories.length === 0 ||
        (e.category !== null && selectedCategories.includes(e.category));
      const matchesGenre =
        selectedGenres.length === 0 ||
        selectedGenres.includes(e.eventGenre);
      const matchesLocation =
        selectedLocations.length === 0 ||
        selectedLocations.includes(e.eventCanonicalLocation);
      // Mehrtägige Events (end_date gesetzt) sollen als "an diesem Tag
      // stattfindend" zählen, solange der Filtertag irgendwo innerhalb ihres
      // Laufzeitraums liegt — nicht nur am Starttag. Daher Bereichsüberlappung
      // statt reinem Start-Datum-Vergleich.
      const eventEnd = e.end_date ?? e.start_date;
      // to === null bedeutet "kein Enddatum" (Filter "Alle"), nicht "Ende ist
      // gleich from" — (to ?? from) hätte "Alle" fälschlich auf "nur heute
      // schon laufende Events" eingeschränkt und künftige Events komplett
      // ausgeblendet (Bug: "Alle" zeigte weniger Events als "Diese Woche").
      const matchesDate =
        dateFilter === 'custom'
          ? selectedDates.some((d) => d >= e.start_date && d <= eventEnd)
          : (to === null || e.start_date <= to) && eventEnd >= from;
      const matchesFavorite = !showFavoritesOnly || favorites.includes(e.id);
      const matchesFree = !showFreeOnly || isFreeEvent(e.price_info);
      const matchesMultiDay = !showMultiDayOnly || (e.end_date !== null && e.end_date !== e.start_date);
      return matchesSearch && matchesCategory && matchesGenre && matchesLocation && matchesDate && matchesFavorite && matchesFree && matchesMultiDay;
    });
  }, [enrichedEvents, debouncedSearch, selectedCategories, selectedGenres, selectedLocations, dateFilter, selectedDates, showFavoritesOnly, favorites, showFreeOnly, showMultiDayOnly]);

  // Damit die Karte (MapNative.web.tsx) exakt dieselben Treffer zeigen kann
  // wie die gerade aktive Filterkombination hier, ohne die komplette
  // Filterlogik (Suche/Kategorie/Genre/Ort/Datum/Favoriten/Kostenlos/
  // Mehrtägig) ein zweites Mal zu implementieren — siehe mapFilterCache.ts.
  // Nicht während loading publizieren: sonst würde ein Wechsel zur Karte
  // mitten im allerersten Ladevorgang ein leeres Zwischenergebnis cachen,
  // das die Karte fälschlich als "wirklich null Treffer" statt als "noch
  // kein Filterkontext vorhanden" läse.
  useEffect(() => {
    if (loading) return;
    setFilteredEventsForMap(
      filteredEvents
        .filter((e) => e.latitude != null && e.longitude != null)
        .map((e) => ({
          id: e.id,
          title: e.title,
          location_name: e.location_name,
          latitude: e.latitude!,
          longitude: e.longitude!,
          start_date: e.start_date,
          start_time: e.start_time,
        }))
    );
  }, [filteredEvents, loading]);

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

  // Genre-Profil aus den eigenen Favoriten: welche Genres tauchen unter den
  // (noch bevorstehenden) favorisierten Events am häufigsten auf. Ohne Login/
  // Accounts ist das die einzige verfügbare "Geschmacks"-Information — nur
  // aus aktuell geladenen (=künftigen) Events ableitbar, bereits vergangene
  // Favoriten fließen nicht ein, da sie gar nicht mehr geladen werden.
  const favoriteGenreProfile = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of enrichedEvents) {
      if (favorites.includes(e.id)) {
        counts.set(e.eventGenre, (counts.get(e.eventGenre) ?? 0) + 1);
      }
    }
    return counts;
  }, [enrichedEvents, favorites]);

  // "Empfohlen"-Leiste nach dem Vorbild von Apps wie Posh/DICE: statt einer
  // reinen chronologischen Liste ein paar Bild-starke Highlights zum
  // schnellen Durchstöbern zeigen. Nimmt bewusst je Serie nur den nächsten
  // Termin (group[0]) und verlangt ein Bild, sonst wäre die Leiste optisch
  // nicht von der Liste unterscheidbar.
  //
  // Tatsächlich personalisiert statt nur chronologisch: eigene Favoriten
  // zuerst, dann Events von gefolgten Veranstaltern ("Lieblingskünstler"),
  // dann Events, deren Genre häufig unter den eigenen Favoriten vorkommt,
  // erst danach schlicht chronologisch. Innerhalb jeder Stufe bleibt die
  // bisherige Sortierung (Datum bzw. Nähe) erhalten — Array.sort ist seit
  // ES2019 stabil, ein reiner Score-Vergleich verändert die Reihenfolge
  // gleich bewerteter Events also nicht. Zusätzlich ein Diversitäts-Deckel
  // (max. 2 pro Veranstalter/Location), damit ein einzelner Anbieter mit
  // vielen Terminen nicht die ganze Leiste füllt.
  const featuredEvents = useMemo(() => {
    const candidates = eventGroups.map((g) => g[0]).filter((e) => e.image_url);

    // eventGroups ist als Event[] getypt (verliert die eventGenre/
    // eventCanonicalLocation-Zusatzfelder von enrichedEvents auf
    // TS-Ebene), daher hier bewusst erneut aus title/category ableiten statt
    // die (zur Laufzeit zwar vorhandenen, statisch aber unbekannten) Felder
    // anzusprechen — bei einer Handvoll Kandidaten kein Performance-Thema.
    function score(e: (typeof candidates)[number]): number {
      if (favorites.includes(e.id)) return 3;
      if (e.organizer && followedOrganizers.includes(e.organizer)) return 2;
      if (favoriteGenreProfile.has(normalizeGenreGroup(e.subcategory ?? e.category))) return 1;
      return 0;
    }

    const ranked = [...candidates].sort((a, b) => score(b) - score(a));

    const perKeyCount = new Map<string, number>();
    const result: typeof candidates = [];
    for (const e of ranked) {
      const key = e.organizer ?? canonicalizeVenue(e.location_name);
      const used = perKeyCount.get(key) ?? 0;
      if (used >= 2) continue;
      perKeyCount.set(key, used + 1);
      result.push(e);
      if (result.length >= 10) break;
    }
    return result;
  }, [eventGroups, favorites, followedOrganizers, favoriteGenreProfile]);

  // Muss vor dem frühen "if (loading) return"-Block unten stehen — Hooks
  // dürfen laut React-Regeln nie bedingt übersprungen werden. Stand hier
  // vorher NACH dem Loading-Guard, was bei jedem Laden ("Rendered more
  // hooks than during the previous render") zum Absturz der ganzen Seite
  // (schwarzer Bildschirm) führte, sobald loading von true auf false wechselte.
  const listData: ListRow[] = useMemo(() => {
    const rows: ListRow[] = [{ kind: 'banner' }];
    // Karussell nur ab 2 Highlights zeigen — bei nur einem Treffer bringt
    // eine eigene Extra-Zeile für dasselbe Event, das eh gleich darunter
    // nochmal in der Liste steht, keinen Mehrwert.
    if (featuredEvents.length > 1) rows.push({ kind: 'featured', events: featuredEvents });
    eventGroups.forEach((group) => rows.push({ kind: 'group', group }));
    return rows;
  }, [featuredEvents, eventGroups]);

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
    if (selectedDates.length === 0) return 'Datum wählen';
    if (selectedDates.length === 1) {
      const [y, m, d] = selectedDates[0].split('-');
      return `${d}.${m}.${y}`;
    }
    const sorted = [...selectedDates].sort();
    const isContiguous = arraysEqual(sorted, buildDateRangeArray(sorted[0], sorted[sorted.length - 1]));
    if (isContiguous) {
      const [, m1, d1] = sorted[0].split('-');
      const [, m2, d2] = sorted[sorted.length - 1].split('-');
      return `${d1}.${m1}.–${d2}.${m2}.`;
    }
    return `${selectedDates.length} Tage`;
  }

  const contentFilterCount = selectedCategories.length + selectedGenres.length + selectedLocations.length;
  const hasAnyActiveFilter =
    search.trim() !== '' ||
    contentFilterCount > 0 ||
    dateFilter !== 'all' ||
    showFavoritesOnly ||
    showFreeOnly ||
    showMultiDayOnly;

  function resetAllFilters() {
    setSearch('');
    setSelectedCategories([]);
    setSelectedGenres([]);
    setSelectedLocations([]);
    setDateFilter('all');
    setSelectedDates([]);
    setShowFavoritesOnly(false);
    setShowFreeOnly(false);
    setShowMultiDayOnly(false);
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
    // Platzhalter-Karten statt nacktem Spinner — bei der Erstladung (jetzt
    // mit 4000+ Events durch eventim entsprechend länger) wirkt eine leere
    // Mitte-des-Screens-Animation länger tot, als sie tatsächlich dauert.
    // Keine Shimmer-Animation, nur statische Blöcke: hält das Risiko klein.
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
        <BottomTabBar active="events" mapRoute="/map" />
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

  // Banner (Titel/Karte-Button) und Offline-Hinweis sind bewusst NICHT Teil
  // des gepinnten Headers — sie scrollen als erste Zeile normal weg. Nur
  // Suche/Datum/Aktions-Buttons bleiben angeheftet. Grund: mit inzwischen 6
  // Aktions-Buttons plus Banner wurde der komplett gepinnte Header auf dem
  // Handy so hoch, dass für die eigentliche Event-Liste darunter kaum noch
  // Platz blieb.
  const bannerSection = (
    <View>
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
        </View>
      </LinearGradient>

      {isOffline && (
        <View style={styles.offlineBanner}>
          <Ionicons name="cloud-offline-outline" size={14} color="#f2c94c" />
          <Text style={styles.offlineBannerText}>
            Offline — zeige zuletzt geladene Events
          </Text>
        </View>
      )}
    </View>
  );

  const listHeader = (
    <View style={styles.listHeaderWrap}>
      <View style={styles.stickyControls}>
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
        </ScrollView>
      </View>

      {/* Horizontal scrollbar statt umbrechend: mit inzwischen 7 Buttons
          (Filter/Favoriten/Kostenlos/Ausstellungen/Nähe/Benachrichtigungen/
          Erinnerung) fraß eine umbrechende Reihe auf dem Handy zu viel von
          der gepinnten Kopfzeile — wächst mit jedem künftigen Button weiter
          in die Höhe. Eine scrollbare Zeile bleibt dagegen dauerhaft auf
          einer Zeilenhöhe, Filter/Favoriten stehen als erste Buttons sofort
          sichtbar. Das Fade-Overlay am rechten Rand signalisiert, dass noch
          mehr Buttons folgen — sonst wirkt die Reihe wie vollständig
          sichtbar und der letzte Button (aktuell "Erinnerung") bleibt
          unentdeckt. */}
      <View style={styles.actionButtonRowWrap}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.actionButtonRow}
      >
        <TouchableOpacity
          style={[styles.filterButton, contentFilterCount > 0 && styles.filterChipActive]}
          onPress={() => setShowFilterModal(true)}
        >
          <Ionicons name="options-outline" size={16} color={contentFilterCount > 0 ? '#000' : '#999'} />
          <Text style={[styles.filterButtonText, contentFilterCount > 0 && styles.filterChipTextActive]}>
            Filter{contentFilterCount > 0 ? ` (${contentFilterCount})` : ''}
          </Text>
        </TouchableOpacity>

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

        <TouchableOpacity
          style={[styles.filterButton, showFreeOnly && styles.filterChipActive]}
          onPress={() => setShowFreeOnly((v) => !v)}
        >
          <Ionicons name="pricetag-outline" size={16} color={showFreeOnly ? '#000' : '#999'} />
          <Text style={[styles.filterButtonText, showFreeOnly && styles.filterChipTextActive]}>
            Kostenlos
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.filterButton, showMultiDayOnly && styles.filterChipActive]}
          onPress={() => setShowMultiDayOnly((v) => !v)}
        >
          <Ionicons name="layers-outline" size={16} color={showMultiDayOnly ? '#000' : '#999'} />
          <Text style={[styles.filterButtonText, showMultiDayOnly && styles.filterChipTextActive]}>
            Ausstellungen
          </Text>
        </TouchableOpacity>

        {Platform.OS === 'web' && (
          <TouchableOpacity
            style={[styles.filterButton, styles.nearbyButtonRow, userLocation && styles.filterChipActive]}
            onPress={toggleNearby}
            disabled={locationStatus === 'loading'}
          >
            {locationStatus === 'loading' ? (
              <ActivityIndicator size="small" color="#999" style={styles.nearbyButtonSpinner} />
            ) : (
              <Ionicons name="location-outline" size={16} color={userLocation ? '#000' : '#999'} />
            )}
            <Text style={[styles.filterButtonText, userLocation && styles.filterChipTextActive]}>
              {locationStatus === 'loading' ? 'Lädt Standort…' : 'Nähe'}
            </Text>
          </TouchableOpacity>
        )}

        {isPushSupported() && (
          <TouchableOpacity
            style={[styles.filterButton, pushEnabled && styles.filterChipActive]}
            onPress={togglePush}
            disabled={pushBusy}
          >
            {pushBusy ? (
              <ActivityIndicator size="small" color="#999" style={styles.nearbyButtonSpinner} />
            ) : (
              <Ionicons
                name={pushEnabled ? 'notifications' : 'notifications-off-outline'}
                size={16}
                color={pushEnabled ? '#000' : '#999'}
              />
            )}
            <Text style={[styles.filterButtonText, pushEnabled && styles.filterChipTextActive]}>
              {pushEnabled ? 'Benachrichtigungen an' : 'Benachrichtigungen'}
            </Text>
          </TouchableOpacity>
        )}

        {isPushSupported() && pushEnabled && (
          <TouchableOpacity
            style={styles.filterButton}
            onPress={() => setShowReminderModal(true)}
          >
            <Ionicons name="time-outline" size={16} color="#999" />
            <Text style={styles.filterButtonText}>
              Erinnerung{reminderOffsets.length > 0 ? ` (${reminderOffsets.length})` : ''}
            </Text>
          </TouchableOpacity>
        )}

        {/* Ersetzt echtes Pull-to-refresh, das auf react-native-web nicht
            funktioniert (RefreshControl ist dort ein reiner No-op-Stub). */}
        <TouchableOpacity style={styles.filterButton} onPress={() => loadEvents(true)} disabled={refreshing}>
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
        <View style={styles.controlRow}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.dateScrollContent}
            style={styles.dateScroll}
          >
            {RADIUS_PRESETS_KM.map((km) => {
              const active = km === null ? nearbyRadiusKm === null : nearbyRadiusKm === km;
              return (
                <TouchableOpacity
                  key={km ?? 'all'}
                  style={[styles.filterChip, active && styles.filterChipActive]}
                  onPress={() => setNearbyRadiusKm(km)}
                >
                  <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>
                    {km === null ? 'Alle' : `${km} km`}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
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

      {(contentFilterCount > 0 || search.trim() !== '') && (
        <View style={styles.activePillsWrap}>
          {search.trim() !== '' && (
            <TouchableOpacity style={[styles.activePill, styles.activePillSearch]} onPress={() => setSearch('')}>
              <Ionicons name="search-outline" size={12} color="#0af" />
              <Text style={styles.activePillText} numberOfLines={1}>{search} ✕</Text>
            </TouchableOpacity>
          )}
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
              <Ionicons name="location-outline" size={12} color="#0af" />
              <Text style={styles.activePillText}>{l} ✕</Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity
            style={styles.activePillResetAll}
            onPress={() => {
              setSearch('');
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
    </View>
  );

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        ref={listRef}
        data={listData}
        keyExtractor={(row) => (row.kind === 'group' ? row.group[0].id : row.kind)}
        contentContainerStyle={styles.list}
        onScroll={(e) => setShowBackToTop(e.nativeEvent.contentOffset.y > 600)}
        scrollEventThrottle={150}
        ListHeaderComponent={listHeader}
        // RN/RNW's eigener Sticky-Mechanismus statt manuellem CSS
        // position:"sticky" auf einem verschachtelten View — letzteres griff
        // innerhalb von FlatLists Web-DOM-Struktur nicht zuverlässig (Buttons
        // blieben beim Herunterscrollen unerreichbar). Pinnt NUR noch
        // Suche/Datum/Aktions-Buttons (siehe listHeader) — Banner und Titel
        // scrollen als normale erste Zeile weg (row.kind === 'banner'),
        // damit der gepinnte Bereich auf dem Handy nicht zu viel Platz frisst.
        stickyHeaderIndices={[0]}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Ionicons name="calendar-clear-outline" size={40} color="#444" />
            <Text style={styles.emptyTitle}>Keine Events gefunden</Text>
            {hasAnyActiveFilter ? (
              <>
                <Text style={styles.emptyHint}>
                  Mit den aktuellen Filtern gibt es nichts zu sehen.
                </Text>
                <TouchableOpacity style={styles.emptyResetButton} onPress={resetAllFilters}>
                  <Text style={styles.emptyResetButtonText}>Alle Filter zurücksetzen</Text>
                </TouchableOpacity>
              </>
            ) : (
              <Text style={styles.emptyHint}>Schau später nochmal vorbei.</Text>
            )}
          </View>
        }
        renderItem={({ item: row }) => {
          if (row.kind === 'banner') {
            return bannerSection;
          }
          if (row.kind === 'featured') {
            return (
              <View style={styles.featuredSection}>
                <View style={styles.featuredSectionTitleRow}>
                  <Ionicons name="sparkles-outline" size={16} color="#fff" />
                  <Text style={styles.featuredSectionTitle}>Empfohlen für dich</Text>
                </View>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.featuredScrollContent}
                >
                  {row.events.map((item) => (
                    <TouchableOpacity
                      key={item.id}
                      style={styles.featuredCard}
                      onPress={() => router.push(`/event/${item.id}`)}
                    >
                      <View style={styles.featuredImageWrap}>
                        <Image source={{ uri: item.image_url! }} style={styles.featuredCardImage} />
                        <View style={styles.featuredDatePill}>
                          <Text style={styles.featuredDatePillText} numberOfLines={1}>
                            {formatDate(item.start_date, item.start_time)}
                          </Text>
                        </View>
                      </View>
                      <View style={styles.featuredCardBody}>
                        <Text style={styles.featuredCardTitle} numberOfLines={2}>
                          {item.title}
                        </Text>
                        {item.location_name && (
                          <Text style={styles.featuredCardMeta} numberOfLines={1}>
                            {item.location_name}
                          </Text>
                        )}
                      </View>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            );
          }
          const group = row.group;
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
                <Ionicons
                  name={isFavorite(item.id) ? 'heart' : 'heart-outline'}
                  size={18}
                  color={isFavorite(item.id) ? '#ff4d6d' : '#fff'}
                />
              </TouchableOpacity>
              {item.image_url ? (
                <Image source={{ uri: item.image_url }} style={styles.cardThumb} />
              ) : (
                // Platzhalter statt einfach nichts zu rendern — sonst rutscht
                // cardBody nach links und Karten ohne Bild sind nicht mehr
                // auf gleicher Höhe mit denen, die eins haben.
                <LinearGradient
                  colors={['#2a0a4a', '#12082e']}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.cardThumb}
                >
                  <Ionicons name="image-outline" size={22} color="rgba(255,255,255,0.35)" />
                </LinearGradient>
              )}
              <View style={styles.cardBody}>
                <View style={styles.badgeRow}>
                  {item.category && <Text style={styles.badge}>{item.category}</Text>}
                  {hasMore && (
                    <View style={styles.seriesBadgeRow}>
                      <Ionicons name="repeat-outline" size={11} color="#999" />
                      <Text style={styles.seriesBadge}>{group.length} Termine</Text>
                    </View>
                  )}
                  {/* Bei einer Serie nur "Ausverkauft" zeigen, wenn wirklich
                      ALLE Termine ausverkauft sind — sonst wäre die Karte
                      irreführend, obwohl group[0] (der nächste Termin) nur
                      einer von vielen ist und andere Termine noch buchbar
                      sein können. Preis/Status pro Termin steht stattdessen
                      in der aufgeklappten Terminliste. */}
                  {(hasMore ? group.every((g) => g.sold_out === true) : item.sold_out === true) && (
                    <Text style={styles.soldOutBadge}>Ausverkauft</Text>
                  )}
                </View>
                <Text style={styles.title}>{item.title}</Text>
                <Text style={styles.meta}>
                  {hasMore ? 'Nächster Termin: ' : ''}
                  {formatDate(item.start_date, item.start_time)}
                  {formatEndDateSuffix(item.start_date, item.end_date)}
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

      {/* Vorlaufzeiten für Favoriten-Erinnerungen — global fürs Gerät, gilt
          für jedes favorisierte Event gleichermaßen (siehe reminderSettings.ts). */}
      <Modal
        visible={showReminderModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowReminderModal(false)}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setShowReminderModal(false)}
        >
          <TouchableOpacity activeOpacity={1} style={styles.modalCard} onPress={() => {}}>
            <Text style={styles.modalTitle}>Erinnerung bei Favoriten</Text>
            <Text style={styles.modalSubtitle}>
              Wann sollen wir dich an ein favorisiertes Event erinnern?
            </Text>
            {REMINDER_OFFSET_OPTIONS.map((option) => {
              const isActive = reminderOffsets.includes(option.minutes);
              return (
                <TouchableOpacity
                  key={option.minutes}
                  style={[styles.modalRow, isActive && styles.modalRowActive]}
                  onPress={() => toggleReminderOffset(option.minutes)}
                >
                  <Text style={[styles.modalRowText, isActive && styles.modalRowTextActive]}>
                    {isActive ? '✓ ' : ''}
                    {option.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
            <View style={styles.modalButtonRow}>
              <TouchableOpacity
                style={styles.modalCloseButton}
                onPress={() => setShowReminderModal(false)}
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
                  <View style={styles.modalRowMeta}>
                    {item.price_info && <Text style={styles.modalRowPrice}>{item.price_info}</Text>}
                    {item.sold_out === true && <Text style={styles.soldOutBadge}>Ausverkauft</Text>}
                  </View>
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
                <Ionicons name="calendar-outline" size={15} color="#fff" />
                <Text style={styles.modalSecondaryButtonText}>
                  Alle {selectedGroup.length} Termine in Kalender speichern
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
      {showBackToTop && (
        <TouchableOpacity
          style={styles.backToTopBtn}
          onPress={() => listRef.current?.scrollToOffset({ offset: 0, animated: true })}
        >
          <Ionicons name="arrow-up" size={20} color="#000" />
        </TouchableOpacity>
      )}
      <BottomTabBar active="events" mapRoute="/map" />
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
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#3a2a00',
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  offlineBannerText: { color: '#f2c94c', fontSize: 12, fontWeight: '600', textAlign: 'center' },
  // Deckt den gesamten gepinnten Header opak ab (siehe stickyHeaderIndices
  // an der FlatList) — sonst würden hochscrollende Event-Karten durch
  // transparente Lücken zwischen den Header-Zeilen hindurchschimmern.
  listHeaderWrap: { backgroundColor: '#000' },
  stickyControls: { paddingTop: 12 },
  headerButtonRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  mapButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
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
  actionButtonRowWrap: { position: 'relative' },
  actionButtonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 8,
    gap: 10,
  },
  actionButtonRowFade: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 8,
    width: 28,
  },
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
  nearbyButtonRow: { flexDirection: 'row', alignItems: 'center' },
  nearbyButtonSpinner: { marginRight: 6 },
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#0af2',
    borderWidth: 1,
    borderColor: '#0af',
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  activePillText: { color: '#0af', fontSize: 12, fontWeight: '600' },
  activePillSearch: { maxWidth: 220 },
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
  // paddingBottom deckt die fixe BottomTabBar ab, sonst wäre die letzte Karte
  // dahinter verdeckt.
  list: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 90 },
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
  empty: { color: '#666', textAlign: 'center', marginTop: 40 },
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
  featuredSection: { marginBottom: 18 },
  featuredSectionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 },
  featuredSectionTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  featuredScrollContent: { paddingRight: 4 },
  featuredCard: {
    width: 220,
    marginRight: 12,
    backgroundColor: '#141414',
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  featuredImageWrap: { position: 'relative' },
  featuredCardImage: { width: '100%', height: 130, backgroundColor: '#1a1a1a' },
  featuredDatePill: {
    position: 'absolute',
    left: 8,
    bottom: 8,
    backgroundColor: 'rgba(0,0,0,0.75)',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    maxWidth: '90%',
  },
  featuredDatePillText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  featuredCardBody: { padding: 10 },
  featuredCardTitle: { color: '#fff', fontSize: 14, fontWeight: '600' },
  featuredCardMeta: { color: '#999', fontSize: 12, marginTop: 4 },
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
  cardThumb: {
    width: 72,
    height: 72,
    borderRadius: 12,
    marginRight: 12,
    backgroundColor: '#1a1a1a',
    alignItems: 'center',
    justifyContent: 'center',
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
  seriesBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  seriesBadge: {
    fontSize: 11,
    fontWeight: '700',
    color: '#999',
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
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  modalRowActive: { backgroundColor: '#0af1' },
  modalRowText: { color: '#ccc', fontSize: 15 },
  modalRowTextActive: { color: '#0af', fontWeight: '700' },
  modalRowMeta: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  modalRowPrice: { color: '#999', fontSize: 13 },
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
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#141414',
    borderRadius: 12,
    paddingVertical: 12,
    marginTop: 10,
  },
  modalSecondaryButtonText: { color: '#fff', fontWeight: '600', fontSize: 13 },
});