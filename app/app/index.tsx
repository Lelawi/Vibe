import { useEffect, useMemo, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  FlatList,
  ActivityIndicator,
  SafeAreaView,
  TextInput,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { supabase } from '../lib/supabase';

type Event = {
  id: string;
  title: string;
  category: string | null;
  start_date: string;
  start_time: string | null;
  location_name: string | null;
};

type DateFilter = 'all' | 'today' | 'week' | 'weekend';

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

// Liefert "YYYY-MM-DD" für ein Date-Objekt, in lokaler Zeit (nicht UTC)
function toLocalDateStr(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Berechnet die Datumsgrenzen für jeden Filter, ausgehend von heute
function getDateRange(filter: DateFilter): { from: string; to: string | null } {
  const today = new Date();
  const todayStr = toLocalDateStr(today);

  if (filter === 'today') {
    return { from: todayStr, to: todayStr };
  }

  if (filter === 'week') {
    const in7Days = new Date(today);
    in7Days.setDate(today.getDate() + 6);
    return { from: todayStr, to: toLocalDateStr(in7Days) };
  }

  if (filter === 'weekend') {
    const dayOfWeek = today.getDay(); // 0 = Sonntag, 6 = Samstag
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

export default function EventListScreen() {
  const router = useRouter();
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');

  useEffect(() => {
    async function loadEvents() {
      const today = new Date().toISOString().slice(0, 10);

      const { data, error } = await supabase
        .from('events')
        .select('id, title, category, start_date, start_time, location_name')
        .gte('start_date', today)
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

  const categories = useMemo(() => {
    const unique = new Set(events.map((e) => e.category).filter(Boolean));
    return Array.from(unique) as string[];
  }, [events]);

  const filteredEvents = useMemo(() => {
    const { from, to } = getDateRange(dateFilter);

    return events.filter((e) => {
      const matchesSearch = e.title.toLowerCase().includes(search.toLowerCase());
      const matchesCategory = !selectedCategory || e.category === selectedCategory;
      const matchesDate =
        e.start_date >= from && (to === null || e.start_date <= to);
      return matchesSearch && matchesCategory && matchesDate;
    });
  }, [events, search, selectedCategory, dateFilter]);

  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator size="large" color="#fff" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.header}>Vibe</Text>
      <Text style={styles.subheader}>Events in München</Text>

      <TextInput
        style={styles.search}
        placeholder="Event suchen..."
        placeholderTextColor="#666"
        value={search}
        onChangeText={setSearch}
      />

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.filterRow}
        contentContainerStyle={{ paddingHorizontal: 16 }}
      >
        {DATE_FILTERS.map((f) => (
          <TouchableOpacity
            key={f.key}
            style={[styles.filterChip, dateFilter === f.key && styles.filterChipActive]}
            onPress={() => setDateFilter(f.key)}
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
      </ScrollView>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.filterRow}
        contentContainerStyle={{ paddingHorizontal: 16, alignItems: 'center' }}
      >
        <TouchableOpacity
          style={[styles.filterChip, !selectedCategory && styles.filterChipActive]}
          onPress={() => setSelectedCategory(null)}
        >
          <Text style={[styles.filterChipText, !selectedCategory && styles.filterChipTextActive]}>
            Alle Kategorien
          </Text>
        </TouchableOpacity>
        {categories.map((cat) => (
          <TouchableOpacity
            key={cat}
            style={[styles.filterChip, selectedCategory === cat && styles.filterChipActive]}
            onPress={() => setSelectedCategory(cat)}
          >
            <Text
              style={[
                styles.filterChipText,
                selectedCategory === cat && styles.filterChipTextActive,
              ]}
            >
              {cat}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <FlatList
        data={filteredEvents}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={<Text style={styles.empty}>Keine Events gefunden.</Text>}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.card}
            onPress={() => router.push(`/event/${item.id}`)}
          >
            {item.category && <Text style={styles.badge}>{item.category}</Text>}
            <Text style={styles.title}>{item.title}</Text>
            <Text style={styles.meta}>
              {formatDate(item.start_date, item.start_time)}
              {item.location_name ? ` · ${item.location_name}` : ''}
            </Text>
          </TouchableOpacity>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' },
  header: { fontSize: 28, fontWeight: '800', color: '#fff', paddingHorizontal: 16, paddingTop: 12 },
  subheader: { fontSize: 14, color: '#999', paddingHorizontal: 16, marginBottom: 12 },
  search: {
    marginHorizontal: 16,
    marginBottom: 12,
    backgroundColor: '#141414',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: '#fff',
    fontSize: 14,
  },
  filterRow: { height: 42, marginBottom: 10 },
  filterChip: {
    backgroundColor: '#141414',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    marginRight: 8,
  },
  filterChipActive: { backgroundColor: '#0af' },
  filterChipText: { color: '#999', fontSize: 13, fontWeight: '600' },
  filterChipTextActive: { color: '#000' },
  list: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 24 },
  empty: { color: '#666', textAlign: 'center', marginTop: 40 },
  card: {
    backgroundColor: '#141414',
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
  },
  badge: {
    fontSize: 11,
    fontWeight: '700',
    color: '#0af',
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  title: { fontSize: 16, fontWeight: '600', color: '#fff', marginBottom: 4 },
  meta: { fontSize: 13, color: '#888' },
});