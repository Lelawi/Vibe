import { useEffect, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  ActivityIndicator,
  SafeAreaView,
  TouchableOpacity,
  Linking,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';

type EventDetail = {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  subcategory: string | null;
  start_date: string;
  start_time: string | null;
  location_name: string | null;
  address: string | null;
  organizer: string | null;
  source_url: string | null;
  latitude: number | null;
  longitude: number | null;
};

function formatDate(dateStr: string, timeStr: string | null) {
  const date = new Date(`${dateStr}T${timeStr ?? '00:00'}`);
  const dateFormatted = date.toLocaleDateString('de-DE', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });
  if (!timeStr) return dateFormatted;
  return `${dateFormatted} · ${timeStr.slice(0, 5)} Uhr`;
}

export default function EventDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [event, setEvent] = useState<EventDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadEvent() {
      const { data, error } = await supabase
        .from('events')
        .select(
          'id, title, description, category, subcategory, start_date, start_time, location_name, address, organizer, source_url, latitude, longitude'
        )
        .eq('id', id)
        .single();

      if (error) {
        console.error('Fehler beim Laden des Events:', error);
      } else {
        setEvent(data);
      }
      setLoading(false);
    }

    if (id) loadEvent();
  }, [id]);

  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator size="large" color="#fff" />
      </SafeAreaView>
    );
  }

  if (!event) {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.errorText}>Event nicht gefunden.</Text>
      </SafeAreaView>
    );
  }

  const hasCoords = event.latitude !== null && event.longitude !== null;

function openInGoogleMaps() {
  if (!hasCoords) return;
  const url = `https://www.google.com/maps/search/?api=1&query=${event!.latitude},${event!.longitude}`;
  Linking.openURL(url);
}

  return (
    <SafeAreaView style={styles.container}>
      {event.category && <Text style={styles.badge}>{event.category}</Text>}
      <Text style={styles.title}>{event.title}</Text>

      <View style={styles.infoBlock}>
        <Text style={styles.infoLabel}>Wann</Text>
        <Text style={styles.infoValue}>
          {formatDate(event.start_date, event.start_time)}
        </Text>
      </View>

      {event.location_name && (
        <TouchableOpacity
          style={styles.infoBlock}
          disabled={!hasCoords}
          onPress={() =>
            router.push({
              pathname: '/map',
              params: { lat: String(event.latitude), lng: String(event.longitude) },
            })
          }
        >
          <Text style={styles.infoLabel}>Wo</Text>
          <Text style={[styles.infoValue, hasCoords && styles.linkValue]}>
            {event.location_name} {hasCoords ? '📍' : ''}
          </Text>
          {event.address && <Text style={styles.infoSubValue}>{event.address}</Text>}
        </TouchableOpacity>
      )}

      {event.subcategory && (
        <View style={styles.infoBlock}>
          <Text style={styles.infoLabel}>Genre</Text>
          <Text style={styles.infoValue}>{event.subcategory}</Text>
        </View>
      )}

      {event.organizer && (
        <View style={styles.infoBlock}>
          <Text style={styles.infoLabel}>Veranstalter</Text>
          <Text style={styles.infoValue}>{event.organizer}</Text>
        </View>
      )}

      {event.description && (
        <View style={styles.infoBlock}>
          <Text style={styles.infoLabel}>Beschreibung</Text>
          <Text style={styles.infoValue}>{event.description}</Text>
        </View>
      )}

      {event.source_url && (
        <TouchableOpacity
          style={styles.button}
          onPress={() => Linking.openURL(event.source_url!)}
        >
          <Text style={styles.buttonText}>Zur Originalseite</Text>
        </TouchableOpacity>
      )}

      {hasCoords && (
        <TouchableOpacity style={styles.secondaryButton} onPress={openInGoogleMaps}>
          <Text style={styles.secondaryButtonText}>In Google Maps öffnen</Text>
        </TouchableOpacity>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000', padding: 16 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' },
  errorText: { color: '#888', fontSize: 15 },
  badge: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0af',
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  title: { fontSize: 24, fontWeight: '800', color: '#fff', marginBottom: 20 },
  infoBlock: { marginBottom: 16 },
  infoLabel: { fontSize: 12, color: '#666', textTransform: 'uppercase', marginBottom: 4 },
  infoValue: { fontSize: 16, color: '#fff' },
  linkValue: { color: '#0af', fontWeight: '600' },
  infoSubValue: { fontSize: 14, color: '#999', marginTop: 2 },
  button: {
    backgroundColor: '#0af',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 12,
  },
  buttonText: { color: '#000', fontWeight: '700', fontSize: 15 },
  secondaryButton: {
    backgroundColor: '#141414',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 10,
  },
  secondaryButtonText: { color: '#fff', fontWeight: '600', fontSize: 15 },
});