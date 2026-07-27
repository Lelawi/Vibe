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
import { supabase } from './lib/supabase';

type Event = {
  id: string;
  title: string;
  category: string | null;
  start_date: string;
  start_time: string | null;
  location_name: string | null;
};

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

export default function App() {
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  useEffect(() => {
    async function loadEvents() {
      const { data, error } = await supabase
        .from('events')
        .select('id, title, category, start_date, start_time, location_name')
        .order('start_date', { ascending: true })
        .limit(200);

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
    return events.filter((e) => {
      const matchesSearch = e.title.toLowerCase().includes(search.toLowerCase());
      const matchesCategory = !selectedCategory || e.category === selectedCategory;
      return matchesSearch && matchesCategory;
    });
  }, [events, search, selectedCategory]);

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
        <TouchableOpacity
          style={[styles.filterChip, !selectedCategory && styles.filterChipActive]}
          onPress={() => setSelectedCategory(null)}
        >
          <Text style={[styles.filterChipText, !selectedCategory && styles.filterChipTextActive]}>
            Alle
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
        ListEmptyComponent={
          <Text style={styles.empty}>Keine Events gefunden.</Text>
        }
        renderItem={({ item }) => (
          <View style={styles.card}>
            {item.category && <Text style={styles.badge}>{item.category}</Text>}
            <Text style={styles.title}>{item.title}</Text>
            <Text style={styles.meta}>
              {formatDate(item.start_date, item.start_time)}
              {item.location_name ? ` · ${item.location_name}` : ''}
            </Text>
          </View>
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
  filterRow: { marginBottom: 12, flexGrow: 0 },
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
  list: { paddingHorizontal: 16, paddingBottom: 24 },
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