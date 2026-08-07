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
  AppState,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import BottomTabBar from '../components/BottomTabBar';
import LanguageToggle from '../components/LanguageToggle';
import FeedbackButton from '../components/FeedbackButton';
import { registerStrings, useTranslation } from '../lib/strings';
import { categoryLabel } from '../lib/eventCategories';
import { supabase } from '../lib/supabase';
import { canonicalizeVenue } from '../lib/venue';
import { computeSeriesKey, seriesDisplayTitle, seriesVariantLabel } from '../lib/seriesKey';
import { setFilteredEventsForMap } from '../lib/mapFilterCache';
import { fuzzyMatch } from '../lib/fuzzySearch';
import { addEventsToCalendar } from '../lib/calendar';
import { useFavorites } from '../lib/favorites';
import { useFollowedOrganizers } from '../lib/followedOrganizers';
import { useFollowedArtists } from '../lib/followedArtists';
import { consumeOnboardingSeed } from '../lib/onboarding';
import { useReminderSettings, REMINDER_OFFSET_OPTIONS } from '../lib/reminderSettings';
import { normalizeGenreGroup } from '../lib/genreGroup';
import {
  hasSavedSearchCriteria,
  matchesSavedSearch,
  useSavedSearches,
  type SavedSearch,
  type SavedSearchCriteria,
} from '../lib/savedSearches';
import {
  isPushSupported,
  isPushEnabled,
  enablePushNotifications,
  disablePushNotifications,
  syncFavoritesToServer,
  syncFiltersToServer,
  syncSavedSearchesToServer,
  syncArtistFollowsToServer,
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
  | { kind: 'filterInfo' }
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

// Mehrwöchige Ausstellungen und andere Dauerläufer bleiben auffindbar,
// stehen im allgemeinen Feed aber hinter punktuellen bzw. kurzen Events.
// Vierzehn Tage trennt typische Festivals/Messen von monatelangen Einträgen,
// ohne ein normales langes Wochenende abzuwerten.
const LONG_RUNNING_DAYS = 14;
function isLongRunningEvent(event: Pick<Event, 'start_date' | 'end_date'>): boolean {
  if (!event.end_date) return false;
  const start = Date.parse(`${event.start_date}T00:00:00Z`);
  const end = Date.parse(`${event.end_date}T00:00:00Z`);
  return Number.isFinite(start) && Number.isFinite(end) && (end - start) / 86_400_000 >= LONG_RUNNING_DAYS;
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

// „Heute Abend“ bleibt bewusst eng gefasst: nur verfügbare Events mit einer
// belastbaren Uhrzeit ab 17 Uhr. Einträge ohne Uhrzeit werden nicht pauschal
// aufgenommen, weil dadurch früher vor allem Märkte und Dauerveranstaltungen
// den eigentlich spontanen Abend-Feed überfüllt hätten.
function isTonightEvent(event: Event, now = new Date()): boolean {
  if (event.sold_out === true || !event.start_time) return false;
  const today = toLocalDateStr(now);
  // Laufende Mehrtages-Events werden nicht jeden Abend erneut als spontaner
  // Tipp geführt; dafür bleiben die normalen Tagesfilter zuständig.
  if (event.start_date !== today || event.start_time.slice(0, 5) < '17:00') return false;
  const startsAt = new Date(`${event.start_date}T${event.start_time}`);
  return Number.isFinite(startsAt.getTime()) && startsAt.getTime() >= now.getTime() - 90 * 60_000;
}

const WEEKDAY_LABELS_BY_LANG = {
  de: ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'],
  en: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
};
const MONTH_LABELS_BY_LANG = {
  de: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
};

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

const PRIMARY_DATE_FILTERS: { key: DateFilter; labelKey: string }[] = [
  { key: 'all', labelKey: 'events.dateFilter.all' },
  { key: 'today', labelKey: 'events.dateFilter.today' },
  { key: 'tomorrow', labelKey: 'events.dateFilter.tomorrow' },
  { key: 'week', labelKey: 'events.dateFilter.week' },
];

registerStrings({
  'events.title': { de: 'Vibe', en: 'Vibe' },
  'events.subtitle': { de: 'Events in München', en: 'Events in Munich' },
  'events.offline': { de: 'Offline — zeige zuletzt geladene Events', en: 'Offline — showing last loaded events' },
  'events.searchPlaceholder': { de: 'Event, Ort, Genre oder Datum suchen...', en: 'Search event, venue, genre or date...' },
  'events.dateFilter.all': { de: 'Alle', en: 'All' },
  'events.dateFilter.today': { de: 'Heute', en: 'Today' },
  'events.dateFilter.tomorrow': { de: 'Morgen', en: 'Tomorrow' },
  'events.dateFilter.week': { de: 'Woche', en: 'Week' },
  'events.dateFilter.weekend': { de: 'Wochenende', en: 'Weekend' },
  'events.chooseDate': { de: 'Datum wählen', en: 'Choose date' },
  'events.daysCount': { de: 'Tage', en: 'days' },
  'events.filter': { de: 'Filter', en: 'Filter' },
  'events.period': { de: 'Zeitraum', en: 'Date range' },
  'events.more': { de: 'Mehr', en: 'More' },
  'events.quickFilters': { de: 'Schnellfilter', en: 'Quick filters' },
  'events.distance': { de: 'Umkreis', en: 'Distance' },
  'events.tonight': { de: 'Heute Abend', en: 'Tonight' },
  'events.savedSearches': { de: 'Gespeicherte Suchen', en: 'Saved searches' },
  'events.savedSearchesHint': { de: 'Gespeicherte Filter lassen sich jederzeit erneut anwenden. Benachrichtigungen werden nur für exakt passende, neue Events verschickt.', en: 'Saved filters can be applied again at any time. Notifications are only sent for exact new matches.' },
  'events.savedSearchName': { de: 'Name, z. B. „Kostenlose Konzerte“', en: 'Name, e.g. “Free concerts”' },
  'events.saveCurrentSearch': { de: 'Aktuelle Filter speichern', en: 'Save current filters' },
  'events.savedSearchPreview': { de: 'Aktuell passende Events', en: 'Currently matching events' },
  'events.savedSearchNeedsFilter': { de: 'Wähle mindestens einen Kategorie-, Genre-, Orts-, Datums- oder Kostenlos-Filter.', en: 'Choose at least one category, genre, venue, date, or free filter.' },
  'events.savedSearchStructuredOnly': { de: 'Freitext und frei gewählte Kalendertage können nicht zuverlässig überwacht werden. Nutze dafür die strukturierten Filter.', en: 'Free text and custom calendar days cannot be monitored reliably. Use the structured filters instead.' },
  'events.apply': { de: 'Anwenden', en: 'Apply' },
  'events.notify': { de: 'Benachrichtigen', en: 'Notify' },
  'events.delete': { de: 'Löschen', en: 'Delete' },
  'events.noSavedSearches': { de: 'Noch keine Suche gespeichert.', en: 'No saved searches yet.' },
  'events.favorites': { de: 'Favoriten', en: 'Favorites' },
  'events.free': { de: 'Kostenlos', en: 'Free' },
  'events.multiDay': { de: 'Ausstellungen', en: 'Exhibitions' },
  'events.nearby': { de: 'Nähe', en: 'Nearby' },
  'events.loadingLocation': { de: 'Lädt Standort…', en: 'Loading location…' },
  'events.notificationsOn': { de: 'Benachrichtigungen an', en: 'Notifications on' },
  'events.notifications': { de: 'Benachrichtigungen', en: 'Notifications' },
  'events.reminder': { de: 'Erinnerung', en: 'Reminder' },
  'events.refresh': { de: 'Aktualisieren', en: 'Refresh' },
  'events.resultsFoundOne': { de: 'Event gefunden', en: 'event found' },
  'events.resultsFoundMany': { de: 'Events gefunden', en: 'events found' },
  'events.resetAllFilters': { de: 'Alle Filter zurücksetzen', en: 'Reset all filters' },
  'events.locationDenied': { de: 'Standort nicht verfügbar — bitte Standortzugriff im Browser erlauben.', en: 'Location unavailable — please allow location access in your browser.' },
  'events.radiusAll': { de: 'Alle', en: 'All' },
  'events.emptyTitle': { de: 'Keine Events gefunden', en: 'No events found' },
  'events.emptyHintFiltered': { de: 'Mit den aktuellen Filtern gibt es nichts zu sehen.', en: "There's nothing to see with the current filters." },
  'events.emptyHint': { de: 'Schau später nochmal vorbei.', en: 'Check back again later.' },
  'events.featuredTitle': { de: 'Empfohlen für dich', en: 'Recommended for you' },
  'events.soldOut': { de: 'Ausverkauft', en: 'Sold out' },
  'events.calendarReset': { de: 'Zurücksetzen', en: 'Reset' },
  'events.calendarDone': { de: 'Fertig', en: 'Done' },
  'events.filterModalTitle': { de: 'Filter', en: 'Filter' },
  'events.filterModalReset': { de: 'Zurücksetzen', en: 'Reset' },
  'events.filterModalDone': { de: 'Fertig', en: 'Done' },
  'events.filterCategory': { de: 'Kategorie', en: 'Category' },
  'events.filterGenre': { de: 'Genre', en: 'Genre' },
  'events.filterLocation': { de: 'Ort', en: 'Location' },
  'events.locationSearchPlaceholder': { de: 'Ort suchen...', en: 'Search location...' },
  'events.resetAll': { de: 'Alle zurücksetzen', en: 'Reset all' },
  'events.reminderModalTitle': { de: 'Erinnerung bei Favoriten', en: 'Reminder for favorites' },
  'events.close': { de: 'Schließen', en: 'Close' },
  'events.dates': { de: 'Termine', en: 'dates' },
  'events.moreDatesOnSource': { de: 'weitere Termine (auf der Quellseite sichtbar)', en: 'more dates (visible on the source page)' },
  'events.reminderModalSubtitle': { de: 'Wann sollen wir dich an ein favorisiertes Event erinnern?', en: 'When should we remind you about a favorited event?' },
});

// Feste Auswahl-Chips statt eines <input type="range">-Sliders: ein
// kontinuierlicher Slider für 1-25km-Einzelschritte war auf dem Handy kaum
// präzise zu bedienen (per Nutzer-Feedback gemeldet) — dieselben Chips wie
// beim Datumsfilter sind mit dem Daumen deutlich zuverlässiger zu treffen
// als ein schmaler Schieberegler.
const RADIUS_PRESETS_KM: (number | null)[] = [null, 1, 2, 5, 10, 25];

const FREE_PRICE_PATTERN = /kostenlos|kostenfrei|gratis|umsonst|eintritt frei|free entry|\b0([.,]0+)?\s*€/i;

function isFreeEvent(priceInfo: string | null) {
  return priceInfo !== null && FREE_PRICE_PATTERN.test(priceInfo);
}

function toggleInSet(current: string[], value: string): string[] {
  return current.includes(value)
    ? current.filter((v) => v !== value)
    : [...current, value];
}

export default function EventListScreen() {
  const { t, language } = useTranslation();
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
  const [showPeriodModal, setShowPeriodModal] = useState(false);
  const [showMoreModal, setShowMoreModal] = useState(false);
  const [filterTab, setFilterTab] = useState<'category' | 'genre' | 'location'>('category');
  const [locationSearch, setLocationSearch] = useState('');
  const [selectedGroup, setSelectedGroup] = useState<Event[] | null>(null);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [locationStatus, setLocationStatus] = useState<'idle' | 'loading' | 'denied'>('idle');
  const [nearbyRadiusKm, setNearbyRadiusKm] = useState<number | null>(null);
  const { favorites, isFavorite, toggleFavorite } = useFavorites();
  const { followedOrganizers } = useFollowedOrganizers();
  const { followedArtists } = useFollowedArtists();
  const { savedSearches, saveSearch, removeSavedSearch } = useSavedSearches();
  const { offsetsMinutes: reminderOffsets, toggleOffset: toggleReminderOffset } = useReminderSettings();
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [showFreeOnly, setShowFreeOnly] = useState(false);
  const [showMultiDayOnly, setShowMultiDayOnly] = useState(false);
  const [showTonightOnly, setShowTonightOnly] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [showReminderModal, setShowReminderModal] = useState(false);
  const [showSavedSearchModal, setShowSavedSearchModal] = useState(false);
  const [savedSearchName, setSavedSearchName] = useState('');

  useEffect(() => {
    if (!isPushSupported()) return;
    isPushEnabled().then(setPushEnabled);
  }, []);

  // Filter sind bewusst reiner useState statt AsyncStorage — bleiben aber auf
  // dem Handy trotzdem "erhalten", weil iOS/Android die installierte PWA beim
  // Schließen meist nur einschläfern statt den Tab wirklich zu beenden, der
  // React-State also einfach weiterlebt. Setzt Filter deshalb explizit beim
  // Wiederaufwecken aus dem Hintergrund zurück, statt sich auf einen echten
  // Neustart zu verlassen, den es auf dem Handy in der Praxis selten gibt
  // (per Nutzer-Feedback erwartet).
  const appState = useRef(AppState.currentState);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (appState.current.match(/inactive|background/) && nextState === 'active') {
        resetAllFilters();
      }
      appState.current = nextState;
    });
    return () => sub.remove();
  }, []);

  // Favoriten und explizit gespeicherte Suchen werden laufend synchronisiert.
  // Die gerade sichtbaren, flüchtigen Feed-Filter sind absichtlich KEIN
  // Push-Abo mehr: Beim bloßen Stöbern entstanden sonst unerwartete Treffer.
  useEffect(() => {
    if (!pushEnabled) return;
    syncFavoritesToServer(favorites);
  }, [pushEnabled, favorites]);

  useEffect(() => {
    if (!pushEnabled) return;
    syncFiltersToServer({
      categories: [],
      genres: [],
      locations: [],
      organizers: followedOrganizers,
    });
  }, [pushEnabled, followedOrganizers]);

  useEffect(() => {
    if (!pushEnabled) return;
    syncSavedSearchesToServer(savedSearches);
  }, [pushEnabled, savedSearches]);

  useEffect(() => {
    if (!pushEnabled) return;
    syncArtistFollowsToServer(followedArtists);
  }, [pushEnabled, followedArtists]);

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

  // Einmalige Übernahme der Onboarding-Auswahl (siehe app/lib/onboarding.ts)
  // — liefert nach dem ersten Abschluss des Onboardings genau einmal die
  // gewählten Kategorien/Nähe-Wunsch, danach dauerhaft null, damit spätere
  // manuelle Filteränderungen nicht bei jedem Mount überschrieben werden.
  useEffect(() => {
    consumeOnboardingSeed().then((seed) => {
      if (!seed) return;
      if (seed.categories.length > 0) setSelectedCategories(seed.categories);
      if (seed.nearby) toggleNearby();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      const matchesTonight = !showTonightOnly || isTonightEvent(e);
      return matchesSearch && matchesCategory && matchesGenre && matchesLocation && matchesDate && matchesFavorite && matchesFree && matchesMultiDay && matchesTonight;
    });
  }, [enrichedEvents, debouncedSearch, selectedCategories, selectedGenres, selectedLocations, dateFilter, selectedDates, showFavoritesOnly, favorites, showFreeOnly, showMultiDayOnly, showTonightOnly]);

  const currentSavedCriteria: SavedSearchCriteria = useMemo(() => ({
    categories: selectedCategories,
    genres: selectedGenres,
    locations: selectedLocations,
    dateFilter: dateFilter === 'custom' ? 'all' : dateFilter,
    freeOnly: showFreeOnly,
    availableOnly: true,
  }), [selectedCategories, selectedGenres, selectedLocations, dateFilter, showFreeOnly]);
  const hasUnsupportedSavedSearchFilter =
    search.trim() !== '' || dateFilter === 'custom' || showFavoritesOnly ||
    showMultiDayOnly || showTonightOnly || userLocation !== null;
  const currentSearchCanBeSaved =
    hasSavedSearchCriteria(currentSavedCriteria) && !hasUnsupportedSavedSearchFilter;
  const savedSearchPreviewCount = useMemo(() => {
    if (!currentSearchCanBeSaved) return 0;
    const today = toLocalDateStr(new Date());
    return enrichedEvents.filter((event) => matchesSavedSearch(event, currentSavedCriteria, today)).length;
  }, [currentSearchCanBeSaved, currentSavedCriteria, enrichedEvents]);

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
    const longRunningDiff = (a: Event[], b: Event[]) =>
      Number(isLongRunningEvent(a[0])) - Number(isLongRunningEvent(b[0]));

    if (userLocation) {
      // Events ohne Koordinaten ans Ende, Rest nach Entfernung aufsteigend.
      const dist = (e: Event) =>
        e.latitude !== null && e.longitude !== null
          ? distanceKm(userLocation.lat, userLocation.lng, e.latitude, e.longitude)
          : Infinity;
      groups.sort((a, b) => longRunningDiff(a, b) || dist(a[0]) - dist(b[0]));
      if (nearbyRadiusKm !== null) {
        // Events ohne Koordinaten (dist === Infinity) fallen bei aktivem
        // Umkreis automatisch raus, da ihre Entfernung nicht bestimmbar ist.
        return groups.filter((g) => dist(g[0]) <= nearbyRadiusKm);
      }
    } else {
      groups.sort((a, b) => longRunningDiff(a, b) || sortKey(a[0]).localeCompare(sortKey(b[0])));
    }
    return groups;
  }, [filteredEvents, userLocation, nearbyRadiusKm]);

  // "Empfohlen"-Leiste nach dem Vorbild von Apps wie Posh/DICE: statt einer
  // reinen chronologischen Liste ein paar Bild-starke Highlights zum
  // schnellen Durchstöbern zeigen. Nimmt bewusst je Serie nur den nächsten
  // Termin (group[0]) und verlangt ein Bild, sonst wäre die Leiste optisch
  // nicht von der Liste unterscheidbar.
  //
  // Events von gefolgten Veranstaltern zuerst, danach chronologisch. Eigene
  // Favoriten beeinflussen diese Leiste bewusst nicht: Sie sollen nur beim
  // explizit aktivierten Favoriten-Filter isoliert werden. Innerhalb jeder
  // Stufe bleibt die
  // bisherige Sortierung (Datum bzw. Nähe) erhalten — Array.sort ist seit
  // ES2019 stabil, ein reiner Score-Vergleich verändert die Reihenfolge
  // gleich bewerteter Events also nicht. Zusätzlich ein Diversitäts-Deckel
  // (max. 2 pro Veranstalter/Location), damit ein einzelner Anbieter mit
  // vielen Terminen nicht die ganze Leiste füllt.
  const featuredEvents = useMemo(() => {
    const candidates = eventGroups
      .map((g) => g[0])
      .filter((e) => e.image_url && !isLongRunningEvent(e));

    // eventGroups ist als Event[] getypt (verliert die eventGenre/
    // eventCanonicalLocation-Zusatzfelder von enrichedEvents auf
    // TS-Ebene), daher hier bewusst erneut aus title/category ableiten statt
    // die (zur Laufzeit zwar vorhandenen, statisch aber unbekannten) Felder
    // anzusprechen — bei einer Handvoll Kandidaten kein Performance-Thema.
    function score(e: (typeof candidates)[number]): number {
      if (e.organizer && followedOrganizers.includes(e.organizer)) return 1;
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
  }, [eventGroups, followedOrganizers]);

  // Muss vor dem frühen "if (loading) return"-Block unten stehen — Hooks
  // dürfen laut React-Regeln nie bedingt übersprungen werden. Stand hier
  // vorher NACH dem Loading-Guard, was bei jedem Laden ("Rendered more
  // hooks than during the previous render") zum Absturz der ganzen Seite
  // (schwarzer Bildschirm) führte, sobald loading von true auf false wechselte.
  const listData: ListRow[] = useMemo(() => {
    const rows: ListRow[] = [{ kind: 'banner' }, { kind: 'filterInfo' }];
    // Karussell nur ab 2 Highlights zeigen — bei nur einem Treffer bringt
    // eine eigene Extra-Zeile für dasselbe Event, das eh gleich darunter
    // nochmal in der Liste steht, keinen Mehrwert.
    if (featuredEvents.length > 1) rows.push({ kind: 'featured', events: featuredEvents });
    eventGroups.forEach((group) => rows.push({ kind: 'group', group }));
    return rows;
  }, [featuredEvents, eventGroups]);

  function openCalendar() {
    setShowTonightOnly(false);
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
    if (selectedDates.length === 0) return t('events.chooseDate');
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
    return `${selectedDates.length} ${t('events.daysCount')}`;
  }

  const contentFilterCount =
    selectedCategories.length +
    selectedGenres.length +
    selectedLocations.length +
    Number(showFavoritesOnly) +
    Number(showFreeOnly) +
    Number(showMultiDayOnly) +
    Number(userLocation !== null);
  const hasAnyActiveFilter =
    search.trim() !== '' ||
    contentFilterCount > 0 ||
    dateFilter !== 'all' ||
    showFavoritesOnly ||
    showFreeOnly ||
    showMultiDayOnly ||
    showTonightOnly ||
    userLocation !== null;

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
    setShowTonightOnly(false);
    setUserLocation(null);
    setNearbyRadiusKm(null);
    setLocationStatus('idle');
  }

  function applySavedSearch(searchToApply: SavedSearch) {
    const criteria = searchToApply.criteria;
    setSearch('');
    setSelectedCategories(criteria.categories);
    setSelectedGenres(criteria.genres);
    setSelectedLocations(criteria.locations);
    setDateFilter(criteria.dateFilter);
    setSelectedDates([]);
    setShowFreeOnly(criteria.freeOnly);
    setShowFavoritesOnly(false);
    setShowMultiDayOnly(false);
    setShowTonightOnly(false);
    setUserLocation(null);
    setNearbyRadiusKm(null);
    setLocationStatus('idle');
    setShowSavedSearchModal(false);
  }

  async function saveCurrentSearch() {
    const name = savedSearchName.trim();
    if (!name || !currentSearchCanBeSaved) return;
    await saveSearch({
      id: typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `search-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name,
      criteria: currentSavedCriteria,
      enabled: pushEnabled,
    });
    setSavedSearchName('');
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
  const resetContentFilters = () => {
    setSelectedCategories([]);
    setSelectedGenres([]);
    setSelectedLocations([]);
    setShowFavoritesOnly(false);
    setShowFreeOnly(false);
    setShowMultiDayOnly(false);
    setUserLocation(null);
    setNearbyRadiusKm(null);
    setLocationStatus('idle');
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
        <BottomTabBar active="events" />
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
  // Suche und die kompakte Datumszeile bleiben angeheftet. Banner und selten
  // benötigte Verwaltungsaktionen scrollen weg, damit auf dem Handy möglichst
  // viel Platz für die eigentliche Event-Liste bleibt.
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
            <Text style={styles.header}>{t('events.title')}</Text>
            <Text style={styles.subheader}>{t('events.subtitle')}</Text>
          </View>
          <View style={styles.headerActions}>
            <FeedbackButton />
            <TouchableOpacity
              style={styles.headerIconButton}
              onPress={() => setShowMoreModal(true)}
              accessibilityRole="button"
              accessibilityLabel={t('events.more')}
            >
              <Ionicons name="ellipsis-horizontal" size={20} color="#fff" />
            </TouchableOpacity>
            <LanguageToggle />
          </View>
        </View>
      </LinearGradient>

      {isOffline && (
        <View style={styles.offlineBanner}>
          <Ionicons name="cloud-offline-outline" size={14} color="#f2c94c" />
          <Text style={styles.offlineBannerText}>
            {t('events.offline')}
          </Text>
        </View>
      )}
    </View>
  );

  const listHeader = (
    <View style={styles.listHeaderWrap}>
      <View style={styles.stickyControls}>
        <View style={styles.searchControlsRow}>
          <View style={styles.searchWrap}>
            <TextInput
              style={[styles.search, styles.searchInput]}
              placeholder={t('events.searchPlaceholder')}
              placeholderTextColor="#666"
              value={search}
              onChangeText={setSearch}
            />
            {search.length > 0 && (
              <TouchableOpacity
                style={styles.searchClearBtn}
                onPress={() => setSearch('')}
                accessibilityRole="button"
                accessibilityLabel={t('events.resetAll')}
              >
                <Text style={styles.searchClearBtnText}>✕</Text>
              </TouchableOpacity>
            )}
          </View>
          <TouchableOpacity
            style={styles.compactFilterButton}
            onPress={() => router.push('/map')}
            accessibilityRole="button"
            accessibilityLabel={t('tabs.map')}
          >
            <Ionicons name="location-outline" size={21} color="#bbb" />
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.compactFilterButton, contentFilterCount > 0 && styles.filterChipActive]}
            onPress={() => setShowFilterModal(true)}
            accessibilityRole="button"
            accessibilityLabel={`${t('events.filter')}${contentFilterCount > 0 ? `, ${contentFilterCount}` : ''}`}
          >
            <Ionicons name="options-outline" size={21} color={contentFilterCount > 0 ? '#000' : '#bbb'} />
            {contentFilterCount > 0 && (
              <View style={styles.filterCountBadge}>
                <Text style={styles.filterCountBadgeText}>{contentFilterCount}</Text>
              </View>
            )}
          </TouchableOpacity>
        </View>

        <View style={styles.primaryDateRow}>
          {PRIMARY_DATE_FILTERS.map((f) => (
            <TouchableOpacity
              key={f.key}
              style={[styles.primaryDateButton, dateFilter === f.key && !showTonightOnly && styles.filterChipActive]}
              onPress={() => {
                setDateFilter(f.key);
                setSelectedDates([]);
                setShowTonightOnly(false);
              }}
            >
              <Text
                style={[
                  styles.primaryDateButtonText,
                  dateFilter === f.key && !showTonightOnly && styles.filterChipTextActive,
                ]}
                numberOfLines={1}
              >
                {t(f.labelKey)}
              </Text>
            </TouchableOpacity>
          ))}

          <TouchableOpacity
            style={[
              styles.primaryDateButton,
              styles.primaryDateMoreButton,
              (dateFilter === 'weekend' || dateFilter === 'custom' || showTonightOnly) && styles.filterChipActive,
            ]}
            onPress={() => setShowPeriodModal(true)}
            accessibilityRole="button"
            accessibilityLabel={t('events.period')}
          >
            <Ionicons
              name="calendar-outline"
              size={19}
              color={dateFilter === 'weekend' || dateFilter === 'custom' || showTonightOnly ? '#000' : '#999'}
            />
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );

  // Ergebniszähler/Radius-Chips/aktive-Filter-Pillen scrollen bewusst NICHT
  // mehr mit (siehe listData unten, kind: 'filterInfo') — sie standen vorher
  // alle im selben angehefteten stickyControls-Block wie Suche und Datum,
  // wodurch auf dem Handy bei mehreren aktiven Filtern (Nähe +
  // mehrere Kategorien) bis zu sechs Zeilen dauerhaft den Bildschirm
  // blockierten, bevor überhaupt eine einzige Veranstaltung sichtbar war
  // (per Nutzer-Screenshot gemeldet). Nur Suche und Datum bleiben
  // angeheftet — das war die ursprüngliche Absicht laut Kommentar oben an
  // stickyHeaderIndices, ist aber durch nachträglich hier reingewachsene
  // Abschnitte aufgeweicht worden.
  const filterInfoSection = (
    <View style={styles.filterInfoWrap}>
      <View style={styles.resultCountRow}>
        <Text style={styles.resultCount}>
          {eventGroups.length} {eventGroups.length === 1 ? t('events.resultsFoundOne') : t('events.resultsFoundMany')}
        </Text>
        {hasAnyActiveFilter && (
          <TouchableOpacity onPress={resetAllFilters}>
            <Text style={styles.resultCountResetLink}>{t('events.resetAllFilters')}</Text>
          </TouchableOpacity>
        )}
      </View>

      {locationStatus === 'denied' && (
        <Text style={styles.locationHint}>
          {t('events.locationDenied')}
        </Text>
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
                {MONTH_LABELS_BY_LANG[language][calendarMonth.month]} {calendarMonth.year}
              </Text>
              <TouchableOpacity onPress={() => shiftCalendarMonth(1)} style={styles.calendarNavBtn}>
                <Text style={styles.calendarNavText}>›</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.calendarWeekRow}>
              {WEEKDAY_LABELS_BY_LANG[language].map((w) => (
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
                  <Text style={styles.calendarClearText}>{t('events.calendarReset')}</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={styles.calendarDoneBtn}
                onPress={() => setShowPicker(false)}
              >
                <Text style={styles.calendarDoneText}>{t('events.calendarDone')}</Text>
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
          {showFavoritesOnly && (
            <TouchableOpacity style={styles.activePill} onPress={() => setShowFavoritesOnly(false)}>
              <Text style={styles.activePillText}>{t('events.favorites')} ✕</Text>
            </TouchableOpacity>
          )}
          {showFreeOnly && (
            <TouchableOpacity style={styles.activePill} onPress={() => setShowFreeOnly(false)}>
              <Text style={styles.activePillText}>{t('events.free')} ✕</Text>
            </TouchableOpacity>
          )}
          {showMultiDayOnly && (
            <TouchableOpacity style={styles.activePill} onPress={() => setShowMultiDayOnly(false)}>
              <Text style={styles.activePillText}>{t('events.multiDay')} ✕</Text>
            </TouchableOpacity>
          )}
          {userLocation && (
            <TouchableOpacity style={styles.activePill} onPress={toggleNearby}>
              <Text style={styles.activePillText}>
                {t('events.nearby')}{nearbyRadiusKm !== null ? ` · ${nearbyRadiusKm} km` : ''} ✕
              </Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={styles.activePillResetAll}
            onPress={resetAllFilters}
          >
            <Text style={styles.activePillResetAllText}>{t('events.resetAll')}</Text>
          </TouchableOpacity>
        </View>
      )}
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
        // Suche und Datum (siehe listHeader) — Banner und Titel
        // scrollen als normale erste Zeile weg (row.kind === 'banner'),
        // damit der gepinnte Bereich auf dem Handy nicht zu viel Platz frisst.
        stickyHeaderIndices={[0]}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Ionicons name="calendar-clear-outline" size={40} color="#444" />
            <Text style={styles.emptyTitle}>{t('events.emptyTitle')}</Text>
            {hasAnyActiveFilter ? (
              <>
                <Text style={styles.emptyHint}>
                  {t('events.emptyHintFiltered')}
                </Text>
                <TouchableOpacity style={styles.emptyResetButton} onPress={resetAllFilters}>
                  <Text style={styles.emptyResetButtonText}>{t('events.resetAllFilters')}</Text>
                </TouchableOpacity>
              </>
            ) : (
              <Text style={styles.emptyHint}>{t('events.emptyHint')}</Text>
            )}
          </View>
        }
        renderItem={({ item: row }) => {
          if (row.kind === 'banner') {
            return bannerSection;
          }
          if (row.kind === 'filterInfo') {
            return filterInfoSection;
          }
          if (row.kind === 'featured') {
            return (
              <View style={styles.featuredSection}>
                <View style={styles.featuredSectionTitleRow}>
                  <Ionicons name="sparkles-outline" size={16} color="#fff" />
                  <Text style={styles.featuredSectionTitle}>{t('events.featuredTitle')}</Text>
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
                          {seriesDisplayTitle(item.title)}
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
                  {item.category && <Text style={styles.badge}>{categoryLabel(item.category, language)}</Text>}
                  {hasMore && (
                    <View style={styles.seriesBadgeRow}>
                      <Ionicons name="repeat-outline" size={11} color="#999" />
                      <Text style={styles.seriesBadge}>{group.length} {t('events.dates')}</Text>
                    </View>
                  )}
                  {/* Bei einer Serie nur "Ausverkauft" zeigen, wenn wirklich
                      ALLE Termine ausverkauft sind — sonst wäre die Karte
                      irreführend, obwohl group[0] (der nächste Termin) nur
                      einer von vielen ist und andere Termine noch buchbar
                      sein können. Preis/Status pro Termin steht stattdessen
                      in der aufgeklappten Terminliste. */}
                  {(hasMore ? group.every((g) => g.sold_out === true) : item.sold_out === true) && (
                    <Text style={styles.soldOutBadge}>{t('events.soldOut')}</Text>
                  )}
                </View>
                <Text style={styles.title}>{seriesDisplayTitle(item.title)}</Text>
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

      <Modal
        visible={showPeriodModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowPeriodModal(false)}
      >
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setShowPeriodModal(false)}>
          <TouchableOpacity activeOpacity={1} style={styles.compactModalCard} onPress={() => {}}>
            <Text style={[styles.modalTitle, styles.compactModalTitle]}>{t('events.period')}</Text>
            <TouchableOpacity
              style={[styles.modalRow, dateFilter === 'weekend' && styles.modalRowActive]}
              onPress={() => {
                setDateFilter('weekend');
                setSelectedDates([]);
                setShowTonightOnly(false);
                setShowPeriodModal(false);
              }}
            >
              <View style={styles.modalRowLabel}>
                <Ionicons name="calendar-outline" size={19} color={dateFilter === 'weekend' ? '#0af' : '#aaa'} />
                <Text style={[styles.modalRowText, dateFilter === 'weekend' && styles.modalRowTextActive]}>
                  {t('events.dateFilter.weekend')}
                </Text>
              </View>
              {dateFilter === 'weekend' && <Ionicons name="checkmark" size={20} color="#0af" />}
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modalRow, showTonightOnly && styles.modalRowActive]}
              onPress={() => {
                setShowTonightOnly(true);
                setDateFilter('all');
                setSelectedDates([]);
                setShowPeriodModal(false);
              }}
            >
              <View style={styles.modalRowLabel}>
                <Ionicons name="moon-outline" size={19} color={showTonightOnly ? '#0af' : '#aaa'} />
                <Text style={[styles.modalRowText, showTonightOnly && styles.modalRowTextActive]}>{t('events.tonight')}</Text>
              </View>
              {showTonightOnly && <Ionicons name="checkmark" size={20} color="#0af" />}
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modalRow, dateFilter === 'custom' && styles.modalRowActive]}
              onPress={() => {
                setShowPeriodModal(false);
                setTimeout(openCalendar, 0);
              }}
            >
              <View style={styles.modalRowLabel}>
                <Ionicons name="calendar-number-outline" size={19} color={dateFilter === 'custom' ? '#0af' : '#aaa'} />
                <Text style={[styles.modalRowText, dateFilter === 'custom' && styles.modalRowTextActive]}>
                  {dateFilter === 'custom' ? customDateLabel() : t('events.chooseDate')}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={19} color="#777" />
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      <Modal
        visible={showMoreModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowMoreModal(false)}
      >
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setShowMoreModal(false)}>
          <TouchableOpacity activeOpacity={1} style={styles.compactModalCard} onPress={() => {}}>
            <Text style={[styles.modalTitle, styles.compactModalTitle]}>{t('events.more')}</Text>
            <TouchableOpacity
              style={styles.modalRow}
              onPress={() => {
                setShowMoreModal(false);
                setShowSavedSearchModal(true);
              }}
            >
              <View style={styles.modalRowLabel}>
                <Ionicons name="bookmark-outline" size={19} color="#aaa" />
                <Text style={styles.modalRowText}>{t('events.savedSearches')}</Text>
              </View>
              {savedSearches.length > 0 && <Text style={styles.utilityCount}>{savedSearches.length}</Text>}
            </TouchableOpacity>
            {isPushSupported() && (
              <TouchableOpacity
                style={[styles.modalRow, pushEnabled && styles.modalRowActive]}
                onPress={() => {
                  setShowMoreModal(false);
                  togglePush();
                }}
                disabled={pushBusy}
              >
                <View style={styles.modalRowLabel}>
                  {pushBusy ? (
                    <ActivityIndicator size="small" color="#999" />
                  ) : (
                    <Ionicons name={pushEnabled ? 'notifications' : 'notifications-off-outline'} size={19} color={pushEnabled ? '#0af' : '#aaa'} />
                  )}
                  <Text style={[styles.modalRowText, pushEnabled && styles.modalRowTextActive]}>
                    {pushEnabled ? t('events.notificationsOn') : t('events.notifications')}
                  </Text>
                </View>
              </TouchableOpacity>
            )}
            {isPushSupported() && pushEnabled && (
              <TouchableOpacity
                style={styles.modalRow}
                onPress={() => {
                  setShowMoreModal(false);
                  setShowReminderModal(true);
                }}
              >
                <View style={styles.modalRowLabel}>
                  <Ionicons name="time-outline" size={19} color="#aaa" />
                  <Text style={styles.modalRowText}>{t('events.reminder')}</Text>
                </View>
                {reminderOffsets.length > 0 && <Text style={styles.utilityCount}>{reminderOffsets.length}</Text>}
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={styles.modalRow}
              onPress={() => {
                setShowMoreModal(false);
                loadEvents(true);
              }}
              disabled={refreshing}
            >
              <View style={styles.modalRowLabel}>
                {refreshing ? <ActivityIndicator size="small" color="#999" /> : <Ionicons name="refresh-outline" size={19} color="#aaa" />}
                <Text style={styles.modalRowText}>{t('events.refresh')}</Text>
              </View>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

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
              <Text style={styles.modalTitle}>{t('events.filterModalTitle')}</Text>
              {contentFilterCount > 0 && (
                <TouchableOpacity onPress={resetContentFilters}>
                  <Text style={styles.modalResetLink}>{t('events.filterModalReset')}</Text>
                </TouchableOpacity>
              )}
            </View>

            <Text style={styles.filterSectionLabel}>{t('events.quickFilters')}</Text>
            <View style={styles.quickFilterGrid}>
              {[
                { key: 'favorites', label: t('events.favorites'), icon: 'heart-outline' as const, active: showFavoritesOnly, toggle: () => setShowFavoritesOnly((v) => !v) },
                { key: 'free', label: t('events.free'), icon: 'pricetag-outline' as const, active: showFreeOnly, toggle: () => setShowFreeOnly((v) => !v) },
                { key: 'multiDay', label: t('events.multiDay'), icon: 'layers-outline' as const, active: showMultiDayOnly, toggle: () => setShowMultiDayOnly((v) => !v) },
              ].map((option) => (
                <TouchableOpacity
                  key={option.key}
                  style={[styles.quickFilterButton, option.active && styles.filterChipActive]}
                  onPress={option.toggle}
                >
                  <Ionicons name={option.icon} size={17} color={option.active ? '#000' : '#999'} />
                  <Text style={[styles.quickFilterButtonText, option.active && styles.filterChipTextActive]} numberOfLines={1}>
                    {option.label}
                  </Text>
                </TouchableOpacity>
              ))}
              {Platform.OS === 'web' && (
                <TouchableOpacity
                  style={[styles.quickFilterButton, userLocation !== null && styles.filterChipActive]}
                  onPress={toggleNearby}
                  disabled={locationStatus === 'loading'}
                >
                  {locationStatus === 'loading' ? (
                    <ActivityIndicator size="small" color="#999" />
                  ) : (
                    <Ionicons name="location-outline" size={17} color={userLocation ? '#000' : '#999'} />
                  )}
                  <Text style={[styles.quickFilterButtonText, userLocation && styles.filterChipTextActive]} numberOfLines={1}>
                    {locationStatus === 'loading' ? t('events.loadingLocation') : t('events.nearby')}
                  </Text>
                </TouchableOpacity>
              )}
            </View>

            {userLocation && (
              <View style={styles.radiusSection}>
                <Text style={styles.filterSectionLabel}>{t('events.distance')}</Text>
                <View style={styles.radiusGrid}>
                  {RADIUS_PRESETS_KM.map((km) => {
                    const active = km === null ? nearbyRadiusKm === null : nearbyRadiusKm === km;
                    return (
                      <TouchableOpacity
                        key={km ?? 'all'}
                        style={[styles.radiusButton, active && styles.filterChipActive]}
                        onPress={() => setNearbyRadiusKm(km)}
                      >
                        <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>
                          {km === null ? t('events.radiusAll') : `${km} km`}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            )}

            <View style={styles.filterTabRow}>
              {(
                [
                  { key: 'category' as const, label: t('events.filterCategory'), count: selectedCategories.length },
                  { key: 'genre' as const, label: t('events.filterGenre'), count: selectedGenres.length },
                  { key: 'location' as const, label: t('events.filterLocation'), count: selectedLocations.length },
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
                placeholder={t('events.locationSearchPlaceholder')}
                placeholderTextColor="#666"
                value={locationSearch}
                onChangeText={setLocationSearch}
              />
            )}

            <FlatList
              style={styles.filterOptionsList}
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
                      {filterTab === 'category' ? categoryLabel(item, language) : item}
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
                <Text style={styles.modalCloseButtonText}>{t('events.filterModalDone')}</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      <Modal
        visible={showSavedSearchModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowSavedSearchModal(false)}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setShowSavedSearchModal(false)}
        >
          <TouchableOpacity activeOpacity={1} style={styles.modalCard} onPress={() => {}}>
            <Text style={[styles.modalTitle, styles.savedSearchTitle]}>{t('events.savedSearches')}</Text>
            <Text style={styles.modalSubtitle}>{t('events.savedSearchesHint')}</Text>
            <ScrollView style={styles.savedSearchList}>
              {savedSearches.length === 0 && (
                <Text style={styles.savedSearchEmpty}>{t('events.noSavedSearches')}</Text>
              )}
              {savedSearches.map((saved) => (
                <View key={saved.id} style={styles.savedSearchRow}>
                  <View style={styles.savedSearchNameWrap}>
                    <Text style={styles.savedSearchName}>{saved.name}</Text>
                    <Text style={styles.savedSearchStatus}>
                      {saved.enabled ? t('events.notify') : `${t('events.notify')}: aus`}
                    </Text>
                  </View>
                  <TouchableOpacity style={styles.savedSearchAction} onPress={() => applySavedSearch(saved)}>
                    <Text style={styles.savedSearchActionText}>{t('events.apply')}</Text>
                  </TouchableOpacity>
                  {isPushSupported() && (
                    <TouchableOpacity
                      style={[styles.savedSearchIconAction, saved.enabled && styles.savedSearchIconActionActive]}
                      onPress={() => saveSearch({ ...saved, enabled: !saved.enabled })}
                      accessibilityLabel={t('events.notify')}
                    >
                      <Ionicons name={saved.enabled ? 'notifications' : 'notifications-outline'} size={17} color={saved.enabled ? '#000' : '#999'} />
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity
                    style={styles.savedSearchIconAction}
                    onPress={() => removeSavedSearch(saved.id)}
                    accessibilityLabel={t('events.delete')}
                  >
                    <Ionicons name="trash-outline" size={17} color="#ff6b6b" />
                  </TouchableOpacity>
                </View>
              ))}

              <View style={styles.savedSearchCreate}>
                <Text style={styles.savedSearchCreateTitle}>{t('events.saveCurrentSearch')}</Text>
                <TextInput
                  style={[styles.search, styles.savedSearchInput]}
                  placeholder={t('events.savedSearchName')}
                  placeholderTextColor="#666"
                  value={savedSearchName}
                  onChangeText={setSavedSearchName}
                />
                {hasUnsupportedSavedSearchFilter ? (
                  <Text style={styles.savedSearchWarning}>{t('events.savedSearchStructuredOnly')}</Text>
                ) : !hasSavedSearchCriteria(currentSavedCriteria) ? (
                  <Text style={styles.savedSearchWarning}>{t('events.savedSearchNeedsFilter')}</Text>
                ) : (
                  <Text style={styles.savedSearchPreview}>
                    {t('events.savedSearchPreview')}: {savedSearchPreviewCount}
                  </Text>
                )}
                <TouchableOpacity
                  style={[styles.modalCloseButton, (!currentSearchCanBeSaved || !savedSearchName.trim()) && styles.savedSearchButtonDisabled]}
                  onPress={saveCurrentSearch}
                  disabled={!currentSearchCanBeSaved || !savedSearchName.trim()}
                >
                  <Text style={styles.modalCloseButtonText}>{t('events.saveCurrentSearch')}</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
            <View style={styles.modalButtonRow}>
              <TouchableOpacity style={styles.modalCloseButton} onPress={() => setShowSavedSearchModal(false)}>
                <Text style={styles.modalCloseButtonText}>{t('events.close')}</Text>
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
            <Text style={styles.modalTitle}>{t('events.reminderModalTitle')}</Text>
            <Text style={styles.modalSubtitle}>
              {t('events.reminderModalSubtitle')}
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
                <Text style={styles.modalCloseButtonText}>{t('events.filterModalDone')}</Text>
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
            <Text style={styles.modalTitle}>
              {selectedGroup?.[0] ? seriesDisplayTitle(selectedGroup[0].title) : ''}
            </Text>
            <Text style={styles.modalSubtitle}>
              {selectedGroup?.length} {t('events.dates')}
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
                  <View style={styles.modalRowContent}>
                    {seriesVariantLabel(item.title) && (
                      <Text style={styles.modalRowVariant}>{seriesVariantLabel(item.title)}</Text>
                    )}
                    <Text style={styles.modalRowText}>{formatDate(item.start_date, item.start_time)}</Text>
                  </View>
                  <View style={styles.modalRowMeta}>
                    {item.price_info && <Text style={styles.modalRowPrice}>{item.price_info}</Text>}
                    {item.sold_out === true && <Text style={styles.soldOutBadge}>{t('events.soldOut')}</Text>}
                  </View>
                </TouchableOpacity>
              )}
              ListFooterComponent={
                selectedGroup && selectedGroup.length > 12 ? (
                  <Text style={styles.modalFooterHint}>
                    + {selectedGroup.length - 12} {t('events.moreDatesOnSource')}
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
                  {language === 'de'
                    ? `Alle ${selectedGroup.length} Termine in Kalender speichern`
                    : `Save all ${selectedGroup.length} dates to calendar`}
                </Text>
              </TouchableOpacity>
            )}
            <View style={styles.modalButtonRow}>
              <TouchableOpacity
                style={styles.modalCloseButton}
                onPress={() => setSelectedGroup(null)}
              >
                <Text style={styles.modalCloseButtonText}>{t('events.close')}</Text>
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
      <BottomTabBar active="events" />
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
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerIconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
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
  filterInfoWrap: { backgroundColor: '#000' },
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
  searchControlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginTop: 16,
    marginBottom: 14,
    gap: 10,
  },
  searchWrap: {
    flex: 1,
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
  compactFilterButton: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: '#141414',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  filterCountBadge: {
    position: 'absolute',
    top: -5,
    right: -5,
    minWidth: 20,
    height: 20,
    paddingHorizontal: 5,
    borderRadius: 10,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#000',
  },
  filterCountBadgeText: { color: '#000', fontSize: 11, fontWeight: '800' },
  primaryDateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 10,
    gap: 6,
  },
  primaryDateButton: {
    flex: 1,
    minWidth: 0,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#141414',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  primaryDateMoreButton: { flexGrow: 0, flexBasis: 42 },
  primaryDateButtonText: { color: '#999', fontSize: 12, fontWeight: '700' },
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
    marginTop: 14,
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
  compactModalCard: {
    backgroundColor: '#0a0a0a',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 16,
    paddingBottom: 20,
  },
  compactModalTitle: { paddingHorizontal: 20, marginBottom: 10 },
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
  modalRowLabel: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 },
  utilityCount: {
    color: '#aaa',
    fontSize: 12,
    fontWeight: '700',
    backgroundColor: '#1d1d1d',
    borderRadius: 10,
    minWidth: 20,
    paddingHorizontal: 6,
    paddingVertical: 2,
    textAlign: 'center',
  },
  filterSectionLabel: {
    color: '#777',
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: 16,
    marginTop: 14,
    marginBottom: 8,
  },
  quickFilterGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 16,
    gap: 8,
  },
  quickFilterButton: {
    flexBasis: '47%',
    flexGrow: 1,
    minWidth: 130,
    height: 42,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    backgroundColor: '#141414',
    borderRadius: 12,
    paddingHorizontal: 10,
  },
  quickFilterButtonText: { color: '#999', fontSize: 13, fontWeight: '600', flexShrink: 1 },
  radiusSection: { marginBottom: 4 },
  radiusGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 16,
    gap: 7,
  },
  radiusButton: {
    minWidth: 55,
    backgroundColor: '#141414',
    borderRadius: 18,
    paddingHorizontal: 12,
    paddingVertical: 9,
    alignItems: 'center',
  },
  filterOptionsList: { minHeight: 100 },
  savedSearchTitle: { paddingHorizontal: 16, marginBottom: 6 },
  savedSearchList: { maxHeight: 430 },
  savedSearchEmpty: { color: '#666', paddingHorizontal: 16, paddingVertical: 16 },
  savedSearchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  savedSearchNameWrap: { flex: 1 },
  savedSearchName: { color: '#fff', fontSize: 14, fontWeight: '700' },
  savedSearchStatus: { color: '#777', fontSize: 11, marginTop: 3 },
  savedSearchAction: { paddingHorizontal: 8, paddingVertical: 8 },
  savedSearchActionText: { color: '#0af', fontSize: 12, fontWeight: '700' },
  savedSearchIconAction: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#141414',
  },
  savedSearchIconActionActive: { backgroundColor: '#0af' },
  savedSearchCreate: { padding: 16, gap: 10 },
  savedSearchCreateTitle: { color: '#fff', fontSize: 15, fontWeight: '700' },
  savedSearchInput: { marginBottom: 0 },
  savedSearchWarning: { color: '#f2c94c', fontSize: 12, lineHeight: 17 },
  savedSearchPreview: { color: '#8ad7ff', fontSize: 12 },
  savedSearchButtonDisabled: { opacity: 0.4 },
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
  modalRowContent: { flex: 1, paddingRight: 12 },
  modalRowVariant: { color: '#fff', fontSize: 14, fontWeight: '700', marginBottom: 3 },
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
