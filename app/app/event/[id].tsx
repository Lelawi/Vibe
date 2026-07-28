import { useEffect, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  Image,
  ActivityIndicator,
  SafeAreaView,
  ScrollView,
  TouchableOpacity,
  Linking,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { addEventToCalendar } from '../../lib/calendar';
import { shareEvent } from '../../lib/share';

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
  image_url: string | null;
  price_info: string | null;
  sold_out: boolean | null;
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
  const [shareStatus, setShareStatus] = useState<'idle' | 'copied'>('idle');
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    async function loadEvent() {
      const { data, error } = await supabase
        .from('events')
        .select(
          'id, title, description, category, subcategory, start_date, start_time, location_name, address, organizer, source_url, image_url, price_info, sold_out, latitude, longitude'
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
  const hasImage = Boolean(event.image_url) && !imageFailed;

  function openInGoogleMaps() {
    if (!hasCoords) return;
    const query = [event.location_name, event.address]
      .filter(Boolean)
      .join(' ')
      .trim();
    const url = query
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`
      : `https://www.google.com/maps/search/?api=1&query=${event!.latitude},${event!.longitude}`;
    Linking.openURL(url);
  }

  async function handleShare() {
    const result = await shareEvent(event!.title, event!.source_url);
    if (result === 'copied') {
      setShareStatus('copied');
      setTimeout(() => setShareStatus('idle'), 2000);
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        {hasImage && (
          <Image
            source={{ uri: event.image_url! }}
            style={styles.image}
            onError={() => setImageFailed(true)}
          />
        )}

        <View style={styles.content}>
          {event.category && <Text style={styles.badge}>{event.category}</Text>}
          <Text style={styles.title}>{event.title}</Text>

          <View style={styles.infoBlock}>
            <Text style={styles.infoLabel}>Wann</Text>
            <Text style={styles.infoValue}>
              {formatDate(event.start_date, event.start_time)}
            </Text>
          </View>

          {(event.price_info || event.sold_out !== null) && (
            <View style={styles.infoBlock}>
              <Text style={styles.infoLabel}>Preis</Text>
              <Text style={styles.infoValue}>
                {event.price_info ?? 'Keine Preisinfo verfügbar'}
                {event.sold_out === true ? '  🔴 Ausverkauft' : ''}
              </Text>
            </View>
          )}

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

          <TouchableOpacity style={styles.secondaryButton} onPress={handleShare}>
            <Text style={styles.secondaryButtonText}>
              {shareStatus === 'copied' ? '✓ Link kopiert' : '📤 Teilen'}
            </Text>
          </TouchableOpacity>

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

          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={() =>
              addEventToCalendar({
                id: event.id,
                title: event.title,
                description: event.description,
                start_date: event.start_date,
                start_time: event.start_time,
                location_name: event.location_name,
                address: event.address,
                source_url: event.source_url,
              })
            }
          >
            <Text style={styles.secondaryButtonText}>📅 In Kalender speichern</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  scrollContent: { paddingBottom: 32 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' },
  errorText: { color: '#888', fontSize: 15 },
  image: { width: '100%', aspectRatio: 16 / 9, backgroundColor: '#141414' },
  content: { padding: 16 },
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
