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
import { openExternalUrl } from '../lib/openExternalUrl';
import { useEventViewMode } from '../lib/eventViewMode';
import BottomTabBar, { type BottomTab } from './BottomTabBar';
import VenueFeedbackButton from './VenueFeedbackButton';
import { registerStrings, useTranslation } from '../lib/strings';
import type { Language } from '../lib/language';

// Feste Auswahl-Chips statt eines <input type="range">-Sliders: ein
// kontinuierlicher Slider für 1-25km-Einzelschritte war auf dem Handy kaum
// präzise zu bedienen (per Nutzer-Feedback gemeldet) — dieselben Chips wie
// beim Küchen-/Datumsfilter sind mit dem Daumen deutlich zuverlässiger zu
// treffen als ein schmaler Schieberegler.
const RADIUS_PRESETS_KM: (number | null)[] = [null, 1, 2, 5, 10, 25];

export type VenueType = 'bar' | 'restaurant' | 'spaeti';

type Venue = {
  id: string;
  name: string;
  name_override: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  opening_hours_raw: string | null;
  opening_hours_override: string | null;
  google_opening_hours: string | null;
  google_place_id: string | null;
  website: string | null;
  phone: string | null;
  image_url: string | null;
  cuisine: string | null;
  lunch_available: boolean;
  lunch_menu_url: string | null;
  dinner_menu_url: string | null;
  beer_price_eur: number | null;
  wifi: boolean | null;
  google_rating: number | null;
  google_rating_count: number | null;
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
      columns: `${VENUE_BASE_COLUMNS},google_opening_hours,google_place_id,name_override,cuisine,lunch_available,lunch_menu_url,dinner_menu_url,beer_price_eur,wifi,google_rating,google_rating_count`,
      fill: (v) => v as unknown as Venue,
    },
    {
      columns: `${VENUE_BASE_COLUMNS},name_override,cuisine,lunch_available,lunch_menu_url,dinner_menu_url,beer_price_eur,wifi,google_rating,google_rating_count`,
      fill: (v) => ({ ...v, google_opening_hours: null } as unknown as Venue),
    },
    {
      columns: `${VENUE_BASE_COLUMNS},name_override,cuisine,lunch_available,lunch_menu_url,dinner_menu_url,beer_price_eur,wifi`,
      fill: (v) => ({ ...v, google_rating: null, google_rating_count: null } as unknown as Venue),
    },
    {
      columns: `${VENUE_BASE_COLUMNS},cuisine,lunch_available,lunch_menu_url,dinner_menu_url,beer_price_eur,wifi`,
      fill: (v) => ({ ...v, name_override: null, google_rating: null, google_rating_count: null } as unknown as Venue),
    },
    {
      columns: `${VENUE_BASE_COLUMNS},cuisine,lunch_available,lunch_menu_url,dinner_menu_url,beer_price_eur`,
      fill: (v) =>
        ({ ...v, name_override: null, wifi: null, google_rating: null, google_rating_count: null } as unknown as Venue),
    },
    {
      columns: `${VENUE_BASE_COLUMNS},cuisine,lunch_available,lunch_menu_url,beer_price_eur`,
      fill: (v) =>
        ({
          ...v,
          name_override: null,
          dinner_menu_url: null,
          wifi: null,
          google_rating: null,
          google_rating_count: null,
        } as unknown as Venue),
    },
    {
      columns: `${VENUE_BASE_COLUMNS},cuisine,lunch_available,lunch_menu_url`,
      fill: (v) =>
        ({
          ...v,
          name_override: null,
          dinner_menu_url: null,
          beer_price_eur: null,
          wifi: null,
          google_rating: null,
          google_rating_count: null,
        } as unknown as Venue),
    },
    {
      columns: `${VENUE_BASE_COLUMNS},cuisine`,
      fill: (v) =>
        ({
          ...v,
          name_override: null,
          lunch_available: false,
          lunch_menu_url: null,
          dinner_menu_url: null,
          beer_price_eur: null,
          wifi: null,
          google_rating: null,
          google_rating_count: null,
        } as unknown as Venue),
    },
    {
      columns: VENUE_BASE_COLUMNS,
      fill: (v) =>
        ({
          ...v,
          name_override: null,
          cuisine: null,
          lunch_available: false,
          lunch_menu_url: null,
          dinner_menu_url: null,
          beer_price_eur: null,
          wifi: null,
          google_rating: null,
          google_rating_count: null,
        } as unknown as Venue),
    },
  ];

  for (let i = 0; i < attempts.length; i++) {
    try {
      const data = await fetchAllVenues<Record<string, unknown>>(type, attempts[i].columns);
      return data.map((row) => {
        const venue = attempts[i].fill(row);
        return { ...venue, google_place_id: venue.google_place_id ?? null };
      });
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
  effectiveName: string;
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
// 'stickyRow' (Schnellfilter-Buttons) und 'filterInfo' (Küche-Chips/
// Ergebniszähler/Umkreis-Chips) getrennt wie bei index.tsx: nur 'stickyRow'
// bleibt beim Scrollen angeheftet, 'filterInfo' scrollt normal mit — siehe
// stickyHeaderIndices weiter unten.
type ListRow =
  | { kind: 'banner' }
  | { kind: 'stickyRow' }
  | { kind: 'filterInfo' }
  | { kind: 'empty' }
  | { kind: 'venue'; venue: EnrichedVenue };

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
registerStrings({
  // Gleicher Banner-Titel wie auf dem Events-Tab ("Vibe") statt eines je
  // Reiter unterschiedlichen Titels — einheitliches Markendesign auf allen
  // 4 Reitern (per Nutzer-Feedback: "bei den anderen fehlt das Vibe
  // Banner"). Der bisherige Titel (Bars/Restaurants/Spätis) steckt weiterhin
  // in der Unterzeile (Öffnungsstatus) und in der Bottom-Tab-Leiste.
  'venues.brand': { de: 'Vibe', en: 'Vibe' },
  'venues.settings': { de: 'Einstellungen', en: 'Settings' },
  'venues.bar.title': { de: 'Bars', en: 'Bars' },
  'venues.restaurant.title': { de: 'Restaurants', en: 'Restaurants' },
  'venues.spaeti.title': { de: 'Spätis', en: 'Kiosks' },
  'venues.bar.searchPlaceholder': { de: 'Bar oder Adresse suchen...', en: 'Search bar or address...' },
  'venues.restaurant.searchPlaceholder': { de: 'Restaurant oder Adresse suchen...', en: 'Search restaurant or address...' },
  'venues.spaeti.searchPlaceholder': { de: 'Späti oder Adresse suchen...', en: 'Search kiosk or address...' },
  'venues.bar.emptyText': { de: 'Keine Bars gefunden.', en: 'No bars found.' },
  'venues.restaurant.emptyText': { de: 'Keine Restaurants gefunden.', en: 'No restaurants found.' },
  'venues.spaeti.emptyText': { de: 'Keine Spätis gefunden.', en: 'No kiosks found.' },
  'venues.reportTitle': { de: 'Melden?', en: 'Report?' },
  'venues.cancel': { de: 'Abbrechen', en: 'Cancel' },
  'venues.report': { de: 'Melden', en: 'Report' },
  'venues.error': { de: 'Fehler', en: 'Error' },
  'venues.openOfTotal': { de: 'von', en: 'of' },
  'venues.openNow': { de: 'gerade geöffnet', en: 'currently open' },
  'venues.cuisineAll': { de: 'Alle', en: 'All' },
  'venues.onlyOpen': { de: 'Nur geöffnet', en: 'Open now' },
  'venues.lunch': { de: 'Mittagslunch', en: 'Lunch menu' },
  'venues.favorites': { de: 'Favoriten', en: 'Favorites' },
  'venues.nearby': { de: 'Nähe', en: 'Nearby' },
  'venues.sortByRating': { de: 'Bewertung', en: 'Rating' },
  'venues.loading': { de: 'Lädt…', en: 'Loading…' },
  'venues.refresh': { de: 'Aktualisieren', en: 'Refresh' },
  'venues.radiusAll': { de: 'Alle', en: 'All' },
  'venues.resultsFoundOne': { de: 'gefunden', en: 'found' },
  'venues.resetAllFilters': { de: 'Alle Filter zurücksetzen', en: 'Reset all filters' },
  'venues.locationDenied': { de: 'Standort nicht verfügbar — bitte Standortzugriff im Browser erlauben.', en: 'Location unavailable — please allow location access in your browser.' },
  'venues.emptyHintFiltered': { de: 'Mit den aktuellen Filtern gibt es nichts zu sehen.', en: "There's nothing to see with the current filters." },
  'venues.emptyHint': { de: 'Schau später nochmal vorbei.', en: 'Check back again later.' },
  'venues.today': { de: 'Heute', en: 'Today' },
  'venues.hoursUnknown': { de: 'Öffnungszeiten unbekannt', en: 'Opening hours unknown' },
  'venues.open': { de: 'Geöffnet', en: 'Open' },
  'venues.closed': { de: 'Geschlossen', en: 'Closed' },
  'venues.website': { de: 'Website', en: 'Website' },
  'venues.call': { de: 'Anrufen', en: 'Call' },
  'venues.googleMaps': { de: 'Google Maps', en: 'Google Maps' },
  'venues.lunchMenu': { de: 'Mittagskarte', en: 'Lunch menu' },
  'venues.dinnerMenu': { de: 'Abendkarte', en: 'Dinner menu' },
  'venues.reportLink': { de: "Gibt's nicht mehr?", en: 'No longer exists?' },
  'venues.pendingReview': { de: '⏳ Als geschlossen gemeldet — wird geprüft', en: '⏳ Reported as closed — under review' },
  'venues.beerPrice': { de: '0,5l Helles', en: '0.5L Helles' },
  'venues.wifi': { de: 'WLAN', en: 'WiFi' },
});

// reportPrompt bleibt eine Funktion statt eines flachen Übersetzungs-Keys —
// der Name der Venue wird mitten im Satz eingesetzt und braucht je Typ
// (Bar/Restaurant/Späti) einen anderen grammatikalischen Artikel im
// deutschen Folgesatz ("Die Bar"/"Das Restaurant"/"Der Späti"), was das
// einfache Schlüssel-Wörterbuch (ohne Platzhalter-Interpolation) nicht
// abbilden kann.
const REPORT_PROMPT: Record<VenueType, (name: string, language: Language) => string> = {
  bar: (name, lang) =>
    lang === 'de'
      ? `"${name}" als "gibt's nicht mehr" melden? Die Bar wird dann zur Prüfung markiert.`
      : `Report "${name}" as "no longer exists"? The bar will then be marked for review.`,
  restaurant: (name, lang) =>
    lang === 'de'
      ? `"${name}" als "gibt's nicht mehr" melden? Das Restaurant wird dann zur Prüfung markiert.`
      : `Report "${name}" as "no longer exists"? The restaurant will then be marked for review.`,
  spaeti: (name, lang) =>
    lang === 'de'
      ? `"${name}" als "gibt's nicht mehr" melden? Der Späti wird dann zur Prüfung markiert.`
      : `Report "${name}" as "no longer exists"? The kiosk will then be marked for review.`,
};

const CONFIG: Record<VenueType, {
  titleKey: string;
  icon: keyof typeof Ionicons.glyphMap;
  mapRoute: string;
  searchPlaceholderKey: string;
  emptyTextKey: string;
}> = {
  bar: {
    titleKey: 'venues.bar.title',
    icon: 'beer-outline',
    mapRoute: '/bars-map',
    searchPlaceholderKey: 'venues.bar.searchPlaceholder',
    emptyTextKey: 'venues.bar.emptyText',
  },
  restaurant: {
    titleKey: 'venues.restaurant.title',
    icon: 'restaurant-outline',
    mapRoute: '/restaurants-map',
    searchPlaceholderKey: 'venues.restaurant.searchPlaceholder',
    emptyTextKey: 'venues.restaurant.emptyText',
  },
  spaeti: {
    titleKey: 'venues.spaeti.title',
    icon: 'storefront-outline',
    mapRoute: '/spaetis-map',
    searchPlaceholderKey: 'venues.spaeti.searchPlaceholder',
    emptyTextKey: 'venues.spaeti.emptyText',
  },
};

const SWITCHER_TAB: Record<VenueType, BottomTab> = { bar: 'bars', restaurant: 'restaurants', spaeti: 'spaetis' };

// OSM-cuisine-Tag-Werte sind rohe, meist englische Kleinschreib-Codes
// ("italian", "steak_house") — dienen als STABILER Filter-/Vergleichswert
// (siehe cuisineFilter-State und v.cuisine-Abgleich weiter unten) und
// dürfen deshalb selbst nicht übersetzt werden, nur ihre ANZEIGE. Deckt die
// in der echten Datenbank häufigsten ~50 Werte ab (per Direktabruf
// verifiziert, 2026-07); unbekannte Werte fallen auf eine simple
// Großschreibung mit "_" -> Leerzeichen zurück statt nichts anzuzeigen.
const CUISINE_LABELS: Record<string, { de: string; en: string }> = {
  italian: { de: 'Italienisch', en: 'Italian' },
  pizza: { de: 'Pizza', en: 'Pizza' },
  vietnamese: { de: 'Vietnamesisch', en: 'Vietnamese' },
  asian: { de: 'Asiatisch', en: 'Asian' },
  regional: { de: 'Regional', en: 'Regional' },
  indian: { de: 'Indisch', en: 'Indian' },
  bavarian: { de: 'Bayerisch', en: 'Bavarian' },
  greek: { de: 'Griechisch', en: 'Greek' },
  sushi: { de: 'Sushi', en: 'Sushi' },
  burger: { de: 'Burger', en: 'Burger' },
  chinese: { de: 'Chinesisch', en: 'Chinese' },
  japanese: { de: 'Japanisch', en: 'Japanese' },
  international: { de: 'International', en: 'International' },
  german: { de: 'Deutsch', en: 'German' },
  thai: { de: 'Thailändisch', en: 'Thai' },
  mediterranean: { de: 'Mediterran', en: 'Mediterranean' },
  turkish: { de: 'Türkisch', en: 'Turkish' },
  korean: { de: 'Koreanisch', en: 'Korean' },
  mexican: { de: 'Mexikanisch', en: 'Mexican' },
  french: { de: 'Französisch', en: 'French' },
  spanish: { de: 'Spanisch', en: 'Spanish' },
  balkan: { de: 'Balkan', en: 'Balkan' },
  steak_house: { de: 'Steakhaus', en: 'Steakhouse' },
  kebab: { de: 'Kebab', en: 'Kebab' },
  afghan: { de: 'Afghanisch', en: 'Afghan' },
  italian_pizza: { de: 'Italienisch/Pizza', en: 'Italian/Pizza' },
  pasta: { de: 'Pasta', en: 'Pasta' },
  noodle: { de: 'Nudeln', en: 'Noodles' },
  austrian: { de: 'Österreichisch', en: 'Austrian' },
  tapas: { de: 'Tapas', en: 'Tapas' },
  croatian: { de: 'Kroatisch', en: 'Croatian' },
  lebanese: { de: 'Libanesisch', en: 'Lebanese' },
  arab: { de: 'Arabisch', en: 'Arabic' },
  persian: { de: 'Persisch', en: 'Persian' },
  fish: { de: 'Fisch', en: 'Fish' },
  seafood: { de: 'Meeresfrüchte', en: 'Seafood' },
  barbecue: { de: 'Grill/BBQ', en: 'Barbecue' },
  american: { de: 'Amerikanisch', en: 'American' },
  ramen: { de: 'Ramen', en: 'Ramen' },
  salad: { de: 'Salat', en: 'Salad' },
  oriental: { de: 'Orientalisch', en: 'Oriental' },
  vegan: { de: 'Vegan', en: 'Vegan' },
  vegetarian: { de: 'Vegetarisch', en: 'Vegetarian' },
  steak: { de: 'Steak', en: 'Steak' },
  chicken: { de: 'Hähnchen', en: 'Chicken' },
  coffee_shop: { de: 'Café', en: 'Coffee shop' },
  ice_cream: { de: 'Eis', en: 'Ice cream' },
  bakery: { de: 'Bäckerei', en: 'Bakery' },
  breakfast: { de: 'Frühstück', en: 'Breakfast' },
  fine_dining: { de: 'Gehoben', en: 'Fine dining' },
  fusion: { de: 'Fusion', en: 'Fusion' },
  polish: { de: 'Polnisch', en: 'Polish' },
  russian: { de: 'Russisch', en: 'Russian' },
  ukrainian: { de: 'Ukrainisch', en: 'Ukrainian' },
  syrian: { de: 'Syrisch', en: 'Syrian' },
  moroccan: { de: 'Marokkanisch', en: 'Moroccan' },
  ethiopian: { de: 'Äthiopisch', en: 'Ethiopian' },
  brazilian: { de: 'Brasilianisch', en: 'Brazilian' },
  peruvian: { de: 'Peruanisch', en: 'Peruvian' },
  argentinian: { de: 'Argentinisch', en: 'Argentinian' },
  filipino: { de: 'Philippinisch', en: 'Filipino' },
  indonesian: { de: 'Indonesisch', en: 'Indonesian' },
  malaysian: { de: 'Malaysisch', en: 'Malaysian' },
  singaporean: { de: 'Singapurisch', en: 'Singaporean' },
  nepalese: { de: 'Nepalesisch', en: 'Nepalese' },
  sri_lankan: { de: 'Sri-lankisch', en: 'Sri Lankan' },
  georgian: { de: 'Georgisch', en: 'Georgian' },
  armenian: { de: 'Armenisch', en: 'Armenian' },
  israeli: { de: 'Israelisch', en: 'Israeli' },
  portuguese: { de: 'Portugiesisch', en: 'Portuguese' },
  dumpling: { de: 'Dumplings', en: 'Dumplings' },
  curry: { de: 'Curry', en: 'Curry' },
  sandwich: { de: 'Sandwich', en: 'Sandwich' },
  deli: { de: 'Feinkost', en: 'Deli' },
};

function cuisineLabel(raw: string, language: Language): string {
  const entry = CUISINE_LABELS[raw];
  if (entry) return entry[language];
  // Unbekannter Wert: "steak_house" -> "Steak House" statt der rohen
  // OSM-Schreibweise, immerhin lesbar statt kryptisch.
  return raw.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// Nur der Name reicht bei generischen OSM-Namen nicht als Suchbegriff (siehe
// gleiche Funktion in VenueLeafletView.web.tsx/VenueMapNative.tsx) — mit
// Adresse ist die Anfrage eindeutig, "München" als Ortszusatz grenzt die
// Freitextsuche ausreichend ein, wenn keine Adresse gepflegt ist (bei
// kleinen Kiosken/Spätis in OSM häufig).
// Namens-/Adress-Freitextsuche statt Koordinate: eine reine "q=lat,lng"-
// oder "q=lat,lng(Label)"-URL zeigt in aktuellem Google Maps nur noch die
// nackte Koordinate ohne Namen/Infos an (per Nutzer-Feedback getestet, das
// Klammer-Label-Format wird nicht mehr ausgewertet) — der Versuch, damit
// Filialketten wie "REWE To Go" präziser zu treffen, war also ein Rückschritt
// gegenüber dieser Textsuche und wurde zurückgenommen. Für Ketten bleibt die
// Freitextsuche mit Adresse die verlässlichere Option, auch wenn sie bei
// unvollständigen Adressdaten gelegentlich mehrere Treffer zeigt.
function googleMapsUrl(name: string, address?: string | null, placeId?: string | null) {
  const query = address ? `${name}, ${address}` : `${name}, München`;
  const base = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  return placeId ? `${base}&query_place_id=${encodeURIComponent(placeId)}` : base;
}

export default function VenueListScreen({ type }: { type: VenueType }) {
  const { t, language } = useTranslation();
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
  // Geteilte, persistierte Einstellung statt eines eigenen lokalen State
  // (wie zuvor) — bis 2026-08-08 hatte dieser Screen einen eigenen,
  // unabhängigen, nicht gespeicherten Umschalter, der komplett losgelöst
  // von der "Ansicht der Eventliste"-Einstellung im Einstellungen-Screen
  // war (dort steuerte sie nur den Events-Tab). Per Nutzer-Feedback: ein
  // Schalter an einer zentralen Stelle für alle 4 Reiter statt eines
  // scheinbar wirkungslosen zweiten Schalters hier.
  const { viewMode, setViewMode } = useEventViewMode();
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [cuisineFilter, setCuisineFilter] = useState<string | null>(null);
  const [lunchOnly, setLunchOnly] = useState(false);
  // Fehlte bisher hier komplett, obwohl der Nähe-Button bei Events dieselbe
  // Zusatzauswahl aufklappt (Umkreis-Slider, null = "Alle").
  const [nearbyRadiusKm, setNearbyRadiusKm] = useState<number | null>(null);
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  // Wird erst jetzt sinnvoll, da immer mehr Venues über den google-ratings-
  // Collector eine echte Google-Bewertung bekommen (per Nutzer-Wunsch,
  // 2026-08-08) — kein persistierter Zustand wie viewMode, da eine reine
  // Momentan-Sortierung ohne Rückwirkung auf andere Screens/Reiter.
  const [sortByRating, setSortByRating] = useState(false);
  // Manche gespeicherten image_url-Werte sind zwischenzeitlich tot (Website
  // hat das Bild umbenannt/entfernt, seit die Collector-Heuristik es
  // gefunden hat) — ohne Fallback zeigte das nur ein leeres schwarzes
  // Rechteck statt des sonst üblichen Farbverlauf-Platzhalters (per Nutzer-
  // Screenshot gemeldet: "Alter Simpel hat nur ein schwarzes Rechteck").
  // Merkt sich fehlgeschlagene IDs, um beim nächsten Render auf den
  // Platzhalter umzuschalten.
  const [brokenImageIds, setBrokenImageIds] = useState<Set<string>>(new Set());
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
        supabase.from('venue_closure_statuses').select('venue_id,status'),
      ]);
      const sortedVenues = venuesData.sort((a, b) =>
        (a.name_override ?? a.name).localeCompare(b.name_override ?? b.name, 'de')
      );
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
  // Badge), bis die automatische Vorprüfung belastbare Evidenz gefunden hat
  // oder der Fall in der manuellen Wochenliste entschieden wurde.
  function confirmReportClosed(venueId: string, venueName: string) {
    const message = REPORT_PROMPT[type](venueName, language);
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      // window.confirm() synchron direkt im Touch-Handler aufzurufen, ließ
      // danach die Suchleiste (und andere Eingaben) unklickbar zurück (per
      // Nutzer-Feedback) — ein bekanntes Problem auf mobilen Browsern: ein
      // blockierender Dialog mitten in einer laufenden Touch-Geste bringt
      // deren Event-Zustand durcheinander. setTimeout(...,0) lässt die
      // auslösende Touch-Geste erst regulär abschließen, bevor der Dialog
      // öffnet.
      setTimeout(() => {
        if (window.confirm(message)) reportClosed(venueId, venueName);
      }, 0);
      return;
    }
    Alert.alert(t('venues.reportTitle'), message, [
      { text: t('venues.cancel'), style: 'cancel' },
      { text: t('venues.report'), style: 'destructive', onPress: () => reportClosed(venueId, venueName) },
    ]);
  }

  async function reportClosed(venueId: string, venueName: string) {
    setClosureStatusByVenue((prev) => new Map(prev).set(venueId, 'pending'));
    const { error } = await supabase.rpc('submit_venue_closure_report', { p_venue_id: venueId });
    const failureMessage =
      language === 'de' ? `Melden von "${venueName}" ist fehlgeschlagen.` : `Reporting "${venueName}" failed.`;
    if (error && Platform.OS === 'web' && typeof window !== 'undefined') {
      window.alert(failureMessage);
    } else if (error) {
      Alert.alert(t('venues.error'), failureMessage);
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
        // Klare Quellenpriorität: Google Places vor manueller/Betreiber-
        // Korrektur vor dem oft ungenauen/veralteten OSM-opening_hours-Tag.
        const effectiveHours = v.google_opening_hours ?? v.opening_hours_override ?? v.opening_hours_raw;
        // Manuell korrigierter Name (z.B. wenn eine Bar umbenannt wurde, OSM
        // das aber noch nicht nachgezogen hat) hat Vorrang vor dem vom
        // Collector aus dem OSM-Tag übernommenen Namen — gleiches Override-
        // Prinzip wie bei effectiveHours oben.
        const effectiveName = v.name_override ?? v.name;
        return {
          ...v,
          effectiveHours,
          effectiveName,
          open: isOpenNow(effectiveHours, now),
          hoursToday: todayLabel(effectiveHours, now, language),
          program: eventsByVenue.get(canonicalizeVenue(effectiveName)) ?? [],
          closureStatus: closureStatusByVenue.get(v.id) ?? null,
          distanceKm:
            userLocation && v.latitude != null && v.longitude != null
              ? distanceKm(userLocation.lat, userLocation.lng, v.latitude, v.longitude)
              : null,
        };
      });
  }, [venues, eventsByVenue, userLocation, closureStatusByVenue, language]);

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

  // Getrennt von filteredVenues, OHNE den onlyOpen-Filter selbst: die Banner-
  // Kennzahl ("X von Y gerade geöffnet") soll immer ein aussagekräftiges
  // Verhältnis zeigen. Vorher wurde openCount aus dem BEREITS gefilterten
  // filteredVenues berechnet — sobald "Nur geöffnet" aktiv war, enthielt die
  // gefilterte Liste zwangsläufig nur noch offene Orte, wodurch die Anzeige
  // immer "X von X" zeigte (tautologisch, verliert die eigentliche Zahl der
  // insgesamt gefundenen Orte — per Nutzer-Feedback z.B. "197/197" bei
  // Spätis gemeldet, obwohl 423 insgesamt gefunden wurden).
  const venuesMatchingOtherFilters = useMemo(() => {
    return enrichedVenues
      .filter((v) => fuzzyMatch([v.effectiveName, v.address, v.cuisine].filter(Boolean).join(' '), search))
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
      });
  }, [enrichedVenues, search, cuisineFilter, lunchOnly, showFavoritesOnly, favorites, userLocation, nearbyRadiusKm]);

  const filteredVenues = useMemo(() => {
    return venuesMatchingOtherFilters
      .filter((v) => !onlyOpen || v.open === true)
      .sort((a, b) => {
        // Explizit gewählte Bewertungs-Sortierung schlägt alles andere —
        // wer sie aktiviert, will erkennbar zuerst die bestbewerteten Orte
        // sehen, auch bei gleichzeitig aktiver Nähe-Suche. Venues ohne
        // Bewertung (null) rutschen ans Ende statt fälschlich vor
        // schlecht bewerteten zu stehen.
        if (sortByRating) {
          const ratingDiff = (b.google_rating ?? -1) - (a.google_rating ?? -1);
          if (ratingDiff !== 0) return ratingDiff;
        }
        // Bei aktiver Nähe-Suche zählt nur die Entfernung — der eigentliche
        // Zweck ist "was ist gleich um die Ecke", ein offener Ort 3km weiter
        // weg soll einen geschlossenen direkt nebenan nicht überstimmen.
        if (a.distanceKm != null && b.distanceKm != null) return a.distanceKm - b.distanceKm;
        const priorityDiff = OPEN_PRIORITY[openState(a.open)] - OPEN_PRIORITY[openState(b.open)];
        if (priorityDiff !== 0) return priorityDiff;
        return a.effectiveName.localeCompare(b.effectiveName, 'de');
      });
  }, [venuesMatchingOtherFilters, onlyOpen, sortByRating]);

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
          name: v.effectiveName,
          address: v.address,
          latitude: v.latitude!,
          longitude: v.longitude!,
          opening_hours_raw: v.effectiveHours,
          open: v.open,
          website: v.website,
          image_url: v.image_url,
          lunch_available: v.lunch_available,
          lunch_menu_url: v.lunch_menu_url,
          dinner_menu_url: v.dinner_menu_url,
          beer_price_eur: v.beer_price_eur,
          wifi: v.wifi,
          google_rating: v.google_rating,
          google_rating_count: v.google_rating_count,
          google_place_id: v.google_place_id,
        }))
    );
  }, [type, filteredVenues, loading]);

  const openCount = useMemo(
    () => venuesMatchingOtherFilters.filter((v) => v.open === true).length,
    [venuesMatchingOtherFilters]
  );
  const switcherActive = SWITCHER_TAB[type];
  const hasAnyActiveFilter = search.trim() !== '' || onlyOpen || cuisineFilter !== null || lunchOnly || showFavoritesOnly;

  function resetAllFilters() {
    setSearch('');
    setOnlyOpen(false);
    setCuisineFilter(null);
    setLunchOnly(false);
    setShowFavoritesOnly(false);
  }

  const listData: ListRow[] = useMemo(() => {
    const rows: ListRow[] = [{ kind: 'banner' }, { kind: 'stickyRow' }, { kind: 'filterInfo' }];
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
        <BottomTabBar active={switcherActive} />
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
          <Text style={styles.header}>{t('venues.brand')}</Text>
          <Text style={styles.subheader}>
            {t(config.titleKey)} · {openCount} {t('venues.openOfTotal')} {venuesMatchingOtherFilters.length} {t('venues.openNow')}
          </Text>
        </View>
        <View style={styles.headerActions}>
          <TouchableOpacity
            style={styles.headerIconButton}
            onPress={() => router.push('/settings')}
            accessibilityRole="button"
            accessibilityLabel={t('venues.settings')}
          >
            <Ionicons name="settings-outline" size={20} color="#fff" />
          </TouchableOpacity>
        </View>
      </View>
    </LinearGradient>
  );

  // Suche + Karte-Icon sitzen bewusst NICHT mehr hier oben, sondern als
  // topSlot direkt über der BottomTabBar (siehe ganz unten im Return) —
  // im Daumenbereich beim Einhandbetrieb, exakt dasselbe Prinzip wie beim
  // Events-Tab (index.tsx), damit sich alle 4 Reiter gleich anfühlen (per
  // Nutzer-Feedback: "Design sollte über das komplette Programm einheitlich
  // sein").
  const bottomSearchBar = (
    <View style={styles.bottomSearchRow}>
      <View style={styles.searchWrap}>
        <TextInput
          style={[styles.search, styles.searchInput]}
          placeholder={t(config.searchPlaceholderKey)}
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

      <TouchableOpacity
        style={styles.compactFilterButton}
        onPress={() => router.push(config.mapRoute)}
        accessibilityRole="button"
        accessibilityLabel={t('tabs.map')}
      >
        <Ionicons name="location-outline" size={21} color="#bbb" />
      </TouchableOpacity>
    </View>
  );

  // Eigene, gepinnte Zeile (kind: 'stickyRow') statt ListHeaderComponent —
  // Letzteres rendert bei FlatList immer VOR data[0], der Banner stand
  // dadurch entgegen der visuellen Absicht UNTER den Filterzeilen statt
  // darüber (per Nutzer-Feedback, gleicher Bug wie zuvor schon bei
  // index.tsx gefixt). Nur die am häufigsten genutzten Schnellfilter bleiben
  // angeheftet — Küche-Chips/Ergebniszähler/Umkreis-Chips scrollen normal
  // mit (siehe filterInfoSection unten), analog zu index.tsx's dateRow vs.
  // filterInfo-Aufteilung.
  const stickyRowSection = (
    <View style={styles.listHeaderWrap}>
      <View style={styles.stickyControls}>
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
              <Text style={[styles.filterButtonText, onlyOpen && styles.filterChipTextActive]}>{t('venues.onlyOpen')}</Text>
            </TouchableOpacity>

            {/* Direkt nach "Geöffnet" statt hinter Favoriten/Mittagskarte —
                per Nutzer-Feedback der mit Abstand meistgeklickte Button
                nach dem Öffnen-Filter, verdient also den zweiten Platz statt
                ans Ende der Zeile verbannt zu werden (2026-08-11). */}
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
                  {locationStatus === 'loading' ? t('venues.loading') : t('venues.nearby')}
                </Text>
              </TouchableOpacity>
            )}

            {type === 'restaurant' && (
              <TouchableOpacity
                style={[styles.filterButton, lunchOnly && styles.filterChipActive]}
                onPress={() => setLunchOnly((v) => !v)}
              >
                <Ionicons name="sunny-outline" size={16} color={lunchOnly ? '#000' : '#999'} />
                <Text style={[styles.filterButtonText, lunchOnly && styles.filterChipTextActive]}>{t('venues.lunch')}</Text>
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
                {t('venues.favorites')}
              </Text>
            </TouchableOpacity>

            {/* Kein eigener Bildkarten/Kompakt-Umschalter mehr hier — steuert
                jetzt zentral die "Ansicht der Eventliste"-Einstellung im
                Einstellungen-Screen für alle 4 Reiter gemeinsam (siehe
                viewMode oben). */}

            <TouchableOpacity
              style={[styles.filterButton, sortByRating && styles.filterChipActive]}
              onPress={() => setSortByRating((v) => !v)}
            >
              <Ionicons name={sortByRating ? 'star' : 'star-outline'} size={16} color={sortByRating ? '#000' : '#999'} />
              <Text style={[styles.filterButtonText, sortByRating && styles.filterChipTextActive]}>{t('venues.sortByRating')}</Text>
            </TouchableOpacity>

            {/* Ersetzt echtes Pull-to-refresh, das auf react-native-web nicht
                funktioniert (RefreshControl ist dort ein reiner No-op-Stub). */}
            <TouchableOpacity style={styles.filterButton} onPress={() => load(true)} disabled={refreshing}>
              {refreshing ? (
                <ActivityIndicator size="small" color="#999" />
              ) : (
                <Ionicons name="refresh-outline" size={16} color="#999" />
              )}
              <Text style={styles.filterButtonText}>{t('venues.refresh')}</Text>
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
      </View>
    </View>
  );

  // Küche-Chips/Ergebniszähler/Umkreis-Chips scrollen bewusst NICHT mehr mit
  // an — sie standen vorher alle im selben angehefteten Block wie Suche und
  // Schnellfilter, wodurch auf dem Handy bei mehreren aktiven Filtern
  // (Umkreis + Küche) mehrere Zeilen dauerhaft den Bildschirm blockierten,
  // bevor überhaupt ein Ort sichtbar war (gleiches Muster wie bei index.tsx).
  const filterInfoSection = (
    <View style={styles.filterInfoWrap}>
      {cuisineOptions.length > 0 && (
        <View style={styles.controlRow}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.cuisineScrollContent}
            style={styles.cuisineScroll}
          >
            {[t('venues.cuisineAll'), ...cuisineOptions].map((cuisine) => {
              const isAllChip = cuisine === t('venues.cuisineAll');
              const active = isAllChip ? !cuisineFilter : cuisineFilter === cuisine;
              return (
                <TouchableOpacity
                  key={cuisine}
                  style={[styles.filterChip, active && styles.filterChipActive]}
                  onPress={() => setCuisineFilter(isAllChip || cuisineFilter === cuisine ? null : cuisine)}
                >
                  <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>
                    {isAllChip ? cuisine : cuisineLabel(cuisine, language)}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

      <View style={styles.resultCountRow}>
        <Text style={styles.resultCount}>
          {filteredVenues.length} {filteredVenues.length === 1 ? t(config.titleKey).slice(0, -1) : t(config.titleKey)} {t('venues.resultsFoundOne')}
        </Text>
        {hasAnyActiveFilter && (
          <TouchableOpacity onPress={resetAllFilters}>
            <Text style={styles.resultCountResetLink}>{t('venues.resetAllFilters')}</Text>
          </TouchableOpacity>
        )}
      </View>

      {locationStatus === 'denied' && (
        <Text style={styles.locationHint}>
          {t('venues.locationDenied')}
        </Text>
      )}

      {userLocation && (
        <View style={styles.controlRow}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.cuisineScrollContent}
            style={styles.cuisineScroll}
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
                    {km === null ? t('venues.radiusAll') : `${km} km`}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}
    </View>
  );

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        ref={listRef}
        data={listData}
        keyExtractor={(row) => (row.kind === 'venue' ? row.venue.id : row.kind)}
        contentContainerStyle={styles.listContent}
        // Pinnt NUR die Schnellfilter-Zeile (data[1], row.kind === 'stickyRow')
        // — Banner (data[0]) scrollt als normale erste Zeile weg, exakt wie
        // beim Events-Tab (index.tsx).
        stickyHeaderIndices={[1]}
        keyboardShouldPersistTaps="handled"
        onScroll={(e) => setShowBackToTop(e.nativeEvent.contentOffset.y > 600)}
        scrollEventThrottle={150}
        renderItem={({ item: row }) => {
          if (row.kind === 'banner') return bannerSection;
          if (row.kind === 'stickyRow') return stickyRowSection;
          if (row.kind === 'filterInfo') return filterInfoSection;

          if (row.kind === 'empty') {
            return (
              <View style={styles.emptyState}>
                <Ionicons name={config.icon} size={40} color="#444" />
                <Text style={styles.emptyTitle}>{t(config.emptyTextKey)}</Text>
                {hasAnyActiveFilter ? (
                  <>
                    <Text style={styles.emptyHint}>{t('venues.emptyHintFiltered')}</Text>
                    <TouchableOpacity style={styles.emptyResetButton} onPress={resetAllFilters}>
                      <Text style={styles.emptyResetButtonText}>{t('venues.resetAllFilters')}</Text>
                    </TouchableOpacity>
                  </>
                ) : (
                  <Text style={styles.emptyHint}>{t('venues.emptyHint')}</Text>
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
            <Text style={styles.venueHours}>{t('venues.today')}: {item.hoursToday}</Text>
          ) : item.effectiveHours ? (
            <Text style={styles.venueHours}>{item.effectiveHours}</Text>
          ) : (
            <Text style={styles.venueHoursUnknown}>{t('venues.hoursUnknown')}</Text>
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
              {/* Mittags-/Abendkarte in einer eigenen Spalte statt in der
                  Reihe mit Website/Anrufen/Google Maps — bei beiden
                  vorhandenen Karten übereinander (per Nutzer-Wunsch), sonst
                  fällt die Spalte automatisch auf eine einzelne Zeile
                  zusammen. */}
              {(item.lunch_menu_url || item.dinner_menu_url) && (
                <View style={styles.menuLinksColumn}>
                  {item.lunch_menu_url && (
                    <TouchableOpacity
                      style={[styles.actionChip, styles.actionChipMenu]}
                      onPress={(e) => {
                        e.stopPropagation();
                        openExternalUrl(item.lunch_menu_url!);
                      }}
                    >
                      <Ionicons name="sunny-outline" size={13} color="#f2c94c" />
                      <Text style={[styles.actionChipText, styles.actionChipTextMenu]}>{t('venues.lunchMenu')}</Text>
                    </TouchableOpacity>
                  )}
                  {item.dinner_menu_url && (
                    <TouchableOpacity
                      style={[styles.actionChip, styles.actionChipMenu]}
                      onPress={(e) => {
                        e.stopPropagation();
                        openExternalUrl(item.dinner_menu_url!);
                      }}
                    >
                      <Ionicons name="moon-outline" size={13} color="#f2c94c" />
                      <Text style={[styles.actionChipText, styles.actionChipTextMenu]}>{t('venues.dinnerMenu')}</Text>
                    </TouchableOpacity>
                  )}
                </View>
              )}
              <View style={styles.cardFooterLinks}>
                {item.website && (
                  <TouchableOpacity
                    style={[styles.actionChip, styles.actionChipWebsite]}
                    onPress={(e) => {
                      e.stopPropagation();
                      openExternalUrl(item.website!);
                    }}
                  >
                    <Ionicons name="globe-outline" size={13} color="#0af" />
                    <Text style={[styles.actionChipText, styles.actionChipTextWebsite]}>{t('venues.website')}</Text>
                  </TouchableOpacity>
                )}
                {item.phone && (
                  <TouchableOpacity
                    style={[styles.actionChip, styles.actionChipCall]}
                    onPress={(e) => {
                      e.stopPropagation();
                      Linking.openURL(`tel:${item.phone}`);
                    }}
                  >
                    <Ionicons name="call-outline" size={13} color="#4ade80" />
                    <Text style={[styles.actionChipText, styles.actionChipTextCall]}>{t('venues.call')}</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  style={[styles.actionChip, styles.actionChipMaps]}
                  onPress={(e) => {
                    e.stopPropagation();
                    openExternalUrl(googleMapsUrl(item.effectiveName, item.address, item.google_place_id));
                  }}
                >
                  <Ionicons name="map-outline" size={13} color="#c084fc" />
                  <Text style={[styles.actionChipText, styles.actionChipTextMaps]}>{t('venues.googleMaps')}</Text>
                </TouchableOpacity>
              </View>
              {/* Eigene Zeile statt neben den Links (space-between): auf dem
                  Handy reichte die Breite oft nicht für Website+Anrufen+
                  Mittagskarte UND diesen Link nebeneinander — sie klebten
                  ohne jeden Abstand aneinander (per Nutzer-Screenshot
                  gemeldet). Als eigene Zeile ist das unabhängig davon, wie
                  viele Links links stehen, immer lesbar. */}
              <View style={styles.reportLinkRow}>
                {item.closureStatus !== 'pending' && (
                  <TouchableOpacity
                    onPress={(e) => {
                      e.stopPropagation();
                      confirmReportClosed(item.id, item.effectiveName);
                    }}
                  >
                    <Text style={styles.reportLink}>{t('venues.reportLink')}</Text>
                  </TouchableOpacity>
                )}
                <VenueFeedbackButton venueId={item.id} />
              </View>
            </View>
          );

          // onImage: true, wenn der Button direkt auf einem Foto liegt (Bild-
          // Karten-Ansicht) statt auf dem dunklen Karten-Hintergrund
          // (Kompakt-Ansicht) — dort braucht er einen eigenen Kreis-
          // Hintergrund, sonst verschwindet das weiße Herz-Outline-Icon auf
          // hellen/weißen Fotos komplett (per Nutzer-Feedback).
          function renderFavoriteButton(onImage: boolean) {
            return (
              <TouchableOpacity
                style={[styles.favoriteBtn, onImage && styles.favoriteBtnOnImage]}
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
          }
          const favoriteButton = renderFavoriteButton(false);

          // Direkt neben dem Namen statt als eigene Zeile weiter unten bei
          // Bierpreis/Mittagskarte/WLAN — dort war es per Nutzer-Feedback
          // schon zu voll (alles in derselben Farbe/Zeilenoptik). Als
          // verschachtelter <Text> im Namen bleibt der Zeilenumbruch/
          // flexShrink des umgebenden venueName-Texts erhalten.
          const ratingInline = item.google_rating != null && (
            <Text style={styles.ratingInline}>
              {'  ⭐ '}
              {item.google_rating.toFixed(1).replace('.', ',')}
              {item.google_rating_count != null ? ` (${item.google_rating_count})` : ''}
            </Text>
          );

          const primaryCuisine = item.cuisine?.split(';')[0]?.trim();
          const primaryCuisineLabel = primaryCuisine ? cuisineLabel(primaryCuisine, language) : undefined;
          const lunchNode = item.lunch_available && (
            <Text style={styles.lunchBadge}>🍽️ {t('venues.lunch')}</Text>
          );
          const beerPriceNode = item.beer_price_eur != null && (
            <Text style={styles.lunchBadge}>🍺 {t('venues.beerPrice')}: {item.beer_price_eur.toFixed(2).replace('.', ',')} €</Text>
          );
          const wifiNode = item.wifi === true && <Text style={styles.lunchBadge}>📶 {t('venues.wifi')}</Text>;

          // Nicht nur auf image_url != null prüfen, sondern auch, ob genau
          // dieses Bild schon mal beim Laden fehlgeschlagen ist (siehe
          // brokenImageIds oben) — sonst bliebe ein toter Link ein leeres
          // schwarzes Rechteck statt auf den Platzhalter umzuschalten.
          const hasUsableImage = Boolean(item.image_url) && !brokenImageIds.has(item.id);
          // Die große Bild-Karten-Größe nur ansetzen, wenn dieser Eintrag
          // tatsächlich den großen Karten-Zweig unten erreicht (Bild-Karten-
          // Modus UND echtes, ladbares Foto vorhanden) — sonst würde ein
          // Eintrag ohne Foto im Bild-Karten-Modus fälschlich mit der großen
          // Boxgröße in die kompakte Zeile durchfallen.
          const useCardsLayout = viewMode === 'cards' && hasUsableImage;
          const image = hasUsableImage ? (
            <Image
              source={{ uri: item.image_url! }}
              style={useCardsLayout ? styles.cardsImage : styles.compactThumb}
              onError={() => setBrokenImageIds((prev) => new Set(prev).add(item.id))}
            />
          ) : (
            <LinearGradient
              colors={['#2a0a4a', '#12082e']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={useCardsLayout ? styles.cardsImage : styles.compactThumb}
            >
              <Ionicons name={config.icon} size={useCardsLayout ? 30 : 22} color="rgba(255,255,255,0.35)" />
            </LinearGradient>
          );

          // Nur Einträge mit echtem Foto als große Bild-Karte zeigen — der
          // riesige Farbverlauf-Platzhalter (gleiche Boxgröße wie ein echtes
          // Foto) bringt ohne Bildinhalt keinen Mehrwert und wirkt gerade auf
          // dem Handy wie verschenkter Platz (per Nutzer-Feedback: "sieht auf
          // dem Handy gut aus, allerdings nur wenn es wirklich Bilder gibt").
          // Einträge ohne Bild fallen automatisch auf die kompakte Zeile
          // zurück, auch wenn der Bild-Karten-Modus aktiv ist.
          if (useCardsLayout) {
            return (
              <TouchableOpacity style={styles.cardsCard} disabled={!hasCoords} onPress={onPress}>
                <View style={styles.cardsImageWrap}>
                  {image}
                  {/* Badge+Herz in derselben Reihenfolge wie in der Kompakt-
                      Ansicht (dort: Badge dann Herz, beide rechts) — vorher
                      lag das Herz links, der Badge rechts, wodurch es beim
                      Wechsel zwischen Bild-Karten und Kompakt-Ansicht die
                      Seite wechselte (per Nutzer-Feedback: "sollte nicht auf
                      die andere Seite springen"). */}
                  <View style={styles.cardsBadgeRow}>
                    {item.open === true && <Text style={styles.openBadge}>{t('venues.open')}</Text>}
                    {item.open === false && <Text style={styles.closedBadge}>{t('venues.closed')}</Text>}
                    {renderFavoriteButton(true)}
                  </View>
                </View>
                <View style={styles.cardsBody}>
                  <Text style={styles.venueName}>
                    {item.effectiveName}
                    {ratingInline}
                  </Text>
                  {(item.address || item.distanceKm != null || primaryCuisineLabel) && (
                    <Text style={styles.venueAddress}>
                      {primaryCuisineLabel ? `${primaryCuisineLabel} · ` : ''}
                      {item.address}
                      {item.address && item.distanceKm != null ? ' · ' : ''}
                      {item.distanceKm != null ? formatDistance(item.distanceKm) : ''}
                    </Text>
                  )}
                  {hoursNode}
                  {lunchNode}
                  {beerPriceNode}
                  {wifiNode}
                  {programNode}
                  {item.closureStatus === 'pending' && (
                    <Text style={styles.pendingBadge}>{t('venues.pendingReview')}</Text>
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
                  <Text style={styles.venueName}>
                    {item.effectiveName}
                    {ratingInline}
                  </Text>
                  <View style={styles.cardHeaderBadges}>
                    {item.open === true && <Text style={styles.openBadge}>{t('venues.open')}</Text>}
                    {item.open === false && <Text style={styles.closedBadge}>{t('venues.closed')}</Text>}
                    {favoriteButton}
                  </View>
                </View>
                {(item.address || item.distanceKm != null || primaryCuisineLabel) && (
                  <Text style={styles.venueAddress}>
                    {primaryCuisineLabel ? `${primaryCuisineLabel} · ` : ''}
                    {item.address}
                    {item.address && item.distanceKm != null ? ' · ' : ''}
                    {item.distanceKm != null ? formatDistance(item.distanceKm) : ''}
                  </Text>
                )}
                {hoursNode}
                {lunchNode}
                {beerPriceNode}
                {wifiNode}
                {programNode}
                {item.closureStatus === 'pending' && (
                  <Text style={styles.pendingBadge}>{t('venues.pendingReview')}</Text>
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
      <BottomTabBar active={switcherActive} topSlot={bottomSearchBar} />
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
  filterInfoWrap: { backgroundColor: '#000' },
  bottomSearchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 10,
    gap: 10,
  },
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
  search: {
    backgroundColor: '#141414',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#fff',
    // Mind. 16px, sonst zoomt iOS Safari beim Fokussieren automatisch rein.
    fontSize: 16,
  },
  searchWrap: { flex: 1, position: 'relative', justifyContent: 'center' },
  searchInput: { paddingRight: 38 },
  compactFilterButton: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: '#141414',
    alignItems: 'center',
    justifyContent: 'center',
  },
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
  // paddingBottom deckt die fixe BottomTabBar ab, sonst wäre die letzte Karte
  // dahinter verdeckt.
  listContent: { paddingHorizontal: 16, paddingBottom: 160 },
  backToTopBtn: {
    position: 'absolute',
    right: 16,
    bottom: 160,
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
    // Auf schmalen (Handy-)Bildschirmen ohne Effekt (Elternbreite liegt
    // darunter), begrenzt aber auf breiten Desktop-Fenstern die Kartenbreite
    // auf eine lesbare Spalte statt auf volle Fensterbreite gestreckt.
    width: '100%',
    maxWidth: 640,
    alignSelf: 'center',
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
    width: '100%',
    maxWidth: 640,
    alignSelf: 'center',
  },
  cardsImageWrap: { position: 'relative' },
  // 4:3 statt vorher fix 160px Höhe (bei typischer Kartenbreite ~2,3:1,
  // deutlich breiter/flacher als die meisten echten Fotos) — mit einem
  // Seitenverhältnis nah an echten Fotoformaten schneidet resizeMode="cover"
  // (Standardwert von Image) beim Zuschnitt viel weniger vom Bild ab (per
  // Nutzer-Feedback: "sind rechteckig, wodurch ein breitziehen nicht gut
  // aussieht").
  cardsImage: { width: '100%', aspectRatio: 4 / 3, backgroundColor: '#1a1a1a', alignItems: 'center', justifyContent: 'center' },
  cardsBody: { padding: 14 },
  cardsBadgeRow: { position: 'absolute', top: 10, right: 10, flexDirection: 'row', alignItems: 'center', gap: 6 },
  cardBody: { flex: 1 },
  cardHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardHeaderBadges: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  favoriteBtn: { padding: 2 },
  // Kreis-Hintergrund nur auf dem Foto-Overlay (Bild-Karten) — auf der
  // dunklen Kompakt-Kartenfläche ist das weiße Herz-Icon immer gut sichtbar,
  // dort würde der zusätzliche Kreis nur unnötig auftragen.
  favoriteBtnOnImage: {
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: 14,
    padding: 5,
  },
  venueName: { color: '#fff', fontSize: 16, fontWeight: '700', flexShrink: 1 },
  ratingInline: { color: '#f2c94c', fontSize: 13, fontWeight: '600' },
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
  cardFooterLinks: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  // Row statt Column: Mittags- und Abendkarte nebeneinander statt
  // übereinander (per Nutzer-Wunsch, spart vertikalen Platz), bleiben aber
  // eine eigene Zeile getrennt von Website/Anrufen/Google Maps.
  menuLinksColumn: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', gap: 8, marginBottom: 8 },
  // Vorher alle vier Aktionen (Website/Anrufen/Mittagskarte/Google Maps) als
  // identisch aussehende blaue Textlinks — kaum auseinanderzuhalten, welcher
  // Link zu welcher Aktion gehört (per Nutzer-Feedback: "sehen sich zu
  // ähnlich"). Jetzt eigene Farbe+Icon je Aktion, an bereits etablierte
  // Bedeutungen in der App angelehnt (Grün wie "Geöffnet", Gelb wie den
  // Mittagslunch-Badge) statt neue Farbcodes zu erfinden.
  actionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  actionChipText: { fontSize: 12, fontWeight: '600' },
  actionChipWebsite: { borderColor: '#00aaff33', backgroundColor: '#00aaff14' },
  actionChipTextWebsite: { color: '#0af' },
  actionChipCall: { borderColor: '#4ade8033', backgroundColor: '#4ade8014' },
  actionChipTextCall: { color: '#4ade80' },
  actionChipMenu: { borderColor: '#f2c94c33', backgroundColor: '#f2c94c14' },
  actionChipTextMenu: { color: '#f2c94c' },
  actionChipMaps: { borderColor: '#c084fc33', backgroundColor: '#c084fc14' },
  actionChipTextMaps: { color: '#c084fc' },
  reportLinkRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6 },
  reportLink: { color: '#555', fontSize: 12 },
  pendingBadge: { color: '#f2c94c', fontSize: 12, fontWeight: '600', marginTop: 8 },
});
