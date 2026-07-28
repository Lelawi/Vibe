import { useEffect, useMemo, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  Image,
  FlatList,
  ActivityIndicator,
  SafeAreaView,
  TextInput,
  TouchableOpacity,
  Platform,
  Modal,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import DateTimePicker from '@react-native-community/datetimepicker';
import { supabase } from '../lib/supabase';
import { canonicalizeVenue } from '../lib/venue';
import { computeSeriesKey } from '../lib/seriesKey';

// Unsichtbar über den Datums-Chip gelegtes <input type="date"> (nur Web) —
// reines CSS-Objekt für das native DOM-Element, keine RN-StyleSheet.
const webDateInputStyle = {
  position: 'absolute' as const,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  width: '100%',
  height: '100%',
  opacity: 0,
  cursor: 'pointer',
  border: 'none',
  padding: 0,
};

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
  start_date: string;
  start_time: string | null;
  location_name: string | null;
};

type DateFilter = 'all' | 'today' | 'week' | 'weekend' | 'custom';

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

function toLocalDateStr(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getDateRange(
  filter: DateFilter,
  customDate: string | null
): { from: string; to: string | null } {
  const today = new Date();
  const todayStr = toLocalDateStr(today);

  if (filter === 'custom' && customDate) {
    return { from: customDate, to: customDate };
  }

  if (filter === 'today') {
    return { from: todayStr, to: todayStr };
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
  { key: 'week', label: 'Diese Woche' },
  { key: 'weekend', label: 'Wochenende' },
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
  const [search, setSearch] = useState('');
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedGenres, setSelectedGenres] = useState<string[]>([]);
  const [selectedLocations, setSelectedLocations] = useState<string[]>([]);
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');
  const [customDate, setCustomDate] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [showLocationModal, setShowLocationModal] = useState(false);
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [showGenreModal, setShowGenreModal] = useState(false);
  const [locationSearch, setLocationSearch] = useState('');
  const [selectedGroup, setSelectedGroup] = useState<Event[] | null>(null);

  useEffect(() => {
    async function loadEvents() {
      const today = new Date().toISOString().slice(0, 10);

      const { data, error } = await supabase
        .from('events')
        .select('id, title, category, subcategory, organizer, address, description, source_url, image_url, start_date, start_time, location_name')
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
    const { from, to } = getDateRange(dateFilter, customDate);
    const query = search.toLowerCase();

    return events.filter((e) => {
      const formattedDate = formatDate(e.start_date, e.start_time).toLowerCase();
      const eventGenre = normalizeGenreGroup(e.subcategory ?? e.category);
      const matchesSearch =
        e.title.toLowerCase().includes(query) ||
        (e.location_name?.toLowerCase().includes(query) ?? false) ||
        (e.category?.toLowerCase().includes(query) ?? false) ||
        (e.subcategory?.toLowerCase().includes(query) ?? false) ||
        eventGenre.toLowerCase().includes(query) ||
        (e.organizer?.toLowerCase().includes(query) ?? false) ||
        (e.address?.toLowerCase().includes(query) ?? false) ||
        (e.description?.toLowerCase().includes(query) ?? false) ||
        (e.source_url?.toLowerCase().includes(query) ?? false) ||
        formattedDate.includes(query);
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
        e.start_date >= from && (to === null || e.start_date <= to);
      return matchesSearch && matchesCategory && matchesGenre && matchesLocation && matchesDate;
    });
  }, [events, search, selectedCategories, selectedGenres, selectedLocations, dateFilter, customDate]);

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
    groups.sort((a, b) => sortKey(a[0]).localeCompare(sortKey(b[0])));
    return groups;
  }, [filteredEvents]);

  function handlePickDate(date: Date) {
    setCustomDate(toLocalDateStr(date));
    setDateFilter('custom');
    setShowPicker(false);
  }

  function customDateLabel() {
    if (!customDate) return '📅 Datum wählen';
    const [y, m, d] = customDate.split('-');
    return `📅 ${d}.${m}.${y}`;
  }

  function locationLabel() {
    if (selectedLocations.length === 0) return '📍 Alle Orte';
    if (selectedLocations.length === 1) return `📍 ${selectedLocations[0]}`;
    return `📍 ${selectedLocations.length} Orte`;
  }

  function categoryLabel() {
    if (selectedCategories.length === 0) return 'Alle Kategorien';
    if (selectedCategories.length === 1) return selectedCategories[0];
    return `${selectedCategories.length} Kategorien`;
  }

  function genreLabel() {
    if (selectedGenres.length === 0) return 'Genre wählen';
    if (selectedGenres.length === 1) return selectedGenres[0];
    return `${selectedGenres.length} Genres`;
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator size="large" color="#fff" />
      </SafeAreaView>
    );
  }

  const listHeader = (
    <>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.header}>Vibe</Text>
          <Text style={styles.subheader}>Events in München</Text>
        </View>
        <TouchableOpacity style={styles.mapButton} onPress={() => router.push('/map')}>
          <Text style={styles.mapButtonText}>🗺️ Karte</Text>
        </TouchableOpacity>
      </View>

      <TextInput
        style={styles.search}
        placeholder="Event, Ort, Genre oder Datum suchen..."
        placeholderTextColor="#666"
        value={search}
        onChangeText={setSearch}
      />

      <View style={styles.filterWrap}>
        {DATE_FILTERS.map((f) => (
          <TouchableOpacity
            key={f.key}
            style={[styles.filterChip, dateFilter === f.key && styles.filterChipActive]}
            onPress={() => {
              setDateFilter(f.key);
              setCustomDate(null);
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

        {Platform.OS === 'web' ? (
          // window.prompt()/alert()/confirm() sind deaktiviert, sobald die
          // PWA "Zum Home-Bildschirm hinzugefügt" im Standalone-Modus läuft
          // (bekannte iOS-Einschränkung) — deshalb hier ein echtes, unsichtbar
          // über den Chip gelegtes <input type="date">, das öffnet den
          // nativen Browser-Datepicker zuverlässig auch standalone.
          <View
            style={[
              styles.filterChip,
              dateFilter === 'custom' && styles.filterChipActive,
              styles.dateInputWrap,
            ]}
          >
            <Text
              style={[
                styles.filterChipText,
                dateFilter === 'custom' && styles.filterChipTextActive,
              ]}
            >
              {customDateLabel()}
            </Text>
            <input
              type="date"
              value={customDate ?? ''}
              onChange={(e) => {
                const value = e.target.value;
                if (value) {
                  setCustomDate(value);
                  setDateFilter('custom');
                } else {
                  setCustomDate(null);
                  setDateFilter('all');
                }
              }}
              style={webDateInputStyle}
            />
          </View>
        ) : (
          <TouchableOpacity
            style={[styles.filterChip, dateFilter === 'custom' && styles.filterChipActive]}
            onPress={() => setShowPicker(true)}
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
        )}
      </View>

      {showPicker && Platform.OS !== 'web' && (
        <DateTimePicker
          value={customDate ? new Date(customDate) : new Date()}
          mode="date"
          display={Platform.OS === 'ios' ? 'inline' : 'default'}
          themeVariant="dark"
          onChange={(_, date) => {
            if (Platform.OS === 'android') setShowPicker(false);
            if (date) handlePickDate(date);
          }}
        />
      )}

      <View style={styles.filterWrap}>
        <TouchableOpacity
          style={[styles.filterChip, selectedCategories.length > 0 && styles.filterChipActive]}
          onPress={() => setShowCategoryModal(true)}
        >
          <Text
            style={[
              styles.filterChipText,
              selectedCategories.length > 0 && styles.filterChipTextActive,
            ]}
          >
            {categoryLabel()}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.filterChip, selectedGenres.length > 0 && styles.filterChipActive]}
          onPress={() => setShowGenreModal(true)}
        >
          <Text
            style={[
              styles.filterChipText,
              selectedGenres.length > 0 && styles.filterChipTextActive,
            ]}
          >
            {genreLabel()}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.filterChip, selectedLocations.length > 0 && styles.filterChipActive]}
          onPress={() => setShowLocationModal(true)}
        >
          <Text
            style={[
              styles.filterChipText,
              selectedLocations.length > 0 && styles.filterChipTextActive,
            ]}
          >
            {locationLabel()}
          </Text>
        </TouchableOpacity>
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
              {item.image_url ? (
                <Image source={{ uri: item.image_url }} style={styles.cardThumb} />
              ) : null}
              <View style={styles.cardBody}>
                <View style={styles.badgeRow}>
                  {item.category && <Text style={styles.badge}>{item.category}</Text>}
                  {hasMore && (
                    <Text style={styles.seriesBadge}>🔁 {group.length} Termine</Text>
                  )}
                </View>
                <Text style={styles.title}>{item.title}</Text>
                <Text style={styles.meta}>
                  {hasMore ? 'Nächster Termin: ' : ''}
                  {formatDate(item.start_date, item.start_time)}
                  {item.location_name ? ` · ${item.location_name}` : ''}
                </Text>
                {item.subcategory ? <Text style={styles.subMeta}>{item.subcategory}</Text> : null}
              </View>
            </TouchableOpacity>
          );
        }}
      />

      {/* Kategorie-Auswahl (Mehrfachauswahl) */}
      <Modal
        visible={showCategoryModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowCategoryModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeaderRow}>
              <Text style={styles.modalTitle}>Kategorien wählen</Text>
              {selectedCategories.length > 0 && (
                <TouchableOpacity onPress={() => setSelectedCategories([])}>
                  <Text style={styles.modalResetLink}>Zurücksetzen</Text>
                </TouchableOpacity>
              )}
            </View>
            <FlatList
              data={categories}
              keyExtractor={(item) => item}
              renderItem={({ item }) => {
                const isActive = selectedCategories.includes(item);
                return (
                  <TouchableOpacity
                    style={[styles.modalRow, isActive && styles.modalRowActive]}
                    onPress={() =>
                      setSelectedCategories((prev) => toggleInSet(prev, item))
                    }
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
                onPress={() => setShowCategoryModal(false)}
              >
                <Text style={styles.modalCloseButtonText}>Fertig</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={showGenreModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowGenreModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeaderRow}>
              <Text style={styles.modalTitle}>Genres wählen</Text>
              {selectedGenres.length > 0 && (
                <TouchableOpacity onPress={() => setSelectedGenres([])}>
                  <Text style={styles.modalResetLink}>Zurücksetzen</Text>
                </TouchableOpacity>
              )}
            </View>
            <FlatList
              data={genres}
              keyExtractor={(item) => item}
              renderItem={({ item }) => {
                const isActive = selectedGenres.includes(item);
                return (
                  <TouchableOpacity
                    style={[styles.modalRow, isActive && styles.modalRowActive]}
                    onPress={() =>
                      setSelectedGenres((prev) => toggleInSet(prev, item))
                    }
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
                onPress={() => setShowGenreModal(false)}
              >
                <Text style={styles.modalCloseButtonText}>Fertig</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Orts-Auswahl (Mehrfachauswahl) */}
      <Modal
        visible={showLocationModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowLocationModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeaderRow}>
              <Text style={styles.modalTitle}>Orte wählen</Text>
              {selectedLocations.length > 0 && (
                <TouchableOpacity onPress={() => setSelectedLocations([])}>
                  <Text style={styles.modalResetLink}>Zurücksetzen</Text>
                </TouchableOpacity>
              )}
            </View>
            <TextInput
              style={styles.search}
              placeholder="Ort suchen..."
              placeholderTextColor="#666"
              value={locationSearch}
              onChangeText={setLocationSearch}
              autoFocus
            />
            <FlatList
              data={filteredLocationOptions}
              keyExtractor={(item) => item}
              renderItem={({ item }) => {
                const isActive = selectedLocations.includes(item);
                return (
                  <TouchableOpacity
                    style={[styles.modalRow, isActive && styles.modalRowActive]}
                    onPress={() =>
                      setSelectedLocations((prev) => toggleInSet(prev, item))
                    }
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
                  setShowLocationModal(false);
                  setLocationSearch('');
                }}
              >
                <Text style={styles.modalCloseButtonText}>Fertig</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Alle Termine einer wiederkehrenden Event-Serie */}
      <Modal
        visible={selectedGroup !== null}
        animationType="slide"
        transparent
        onRequestClose={() => setSelectedGroup(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
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
            <View style={styles.modalButtonRow}>
              <TouchableOpacity
                style={styles.modalCloseButton}
                onPress={() => setSelectedGroup(null)}
              >
                <Text style={styles.modalCloseButtonText}>Schließen</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  header: { fontSize: 28, fontWeight: '800', color: '#fff' },
  subheader: { fontSize: 14, color: '#999' },
  mapButton: {
    backgroundColor: '#141414',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  mapButtonText: { color: '#0af', fontWeight: '600', fontSize: 13 },
  search: {
    marginHorizontal: 16,
    marginTop: 16,
    marginBottom: 14,
    backgroundColor: '#141414',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#fff',
    // Mind. 16px, sonst zoomt iOS Safari beim Fokussieren automatisch rein
    // und das Layout muss danach manuell zurückgezoomt werden.
    fontSize: 16,
  },
  filterWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  filterChip: {
    backgroundColor: '#141414',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginRight: 8,
    marginBottom: 8,
  },
  dateInputWrap: {
    position: 'relative',
    overflow: 'hidden',
  },
  filterChipActive: { backgroundColor: '#0af' },
  filterChipText: { color: '#999', fontSize: 13, fontWeight: '600' },
  filterChipTextActive: { color: '#000' },
  list: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 24 },
  empty: { color: '#666', textAlign: 'center', marginTop: 40 },
  card: {
    flexDirection: 'row',
    backgroundColor: '#141414',
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
  },
  cardThumb: {
    width: 64,
    height: 64,
    borderRadius: 10,
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
    color: '#0af',
    textTransform: 'uppercase',
    marginRight: 8,
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
  title: { fontSize: 16, fontWeight: '600', color: '#fff', marginBottom: 4 },
  meta: { fontSize: 13, color: '#888' },
  subMeta: { fontSize: 12, color: '#666', marginTop: 2 },
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
});