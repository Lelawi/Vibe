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
  TextInput,
  Modal,
  Linking,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { supabase } from '../../lib/supabase';
import { addEventToCalendar } from '../../lib/calendar';
import { shareEvent } from '../../lib/share';
import { useFavorites } from '../../lib/favorites';

const REPORT_REASONS = ['Ort/Adresse falsch', 'Datum/Uhrzeit falsch', 'Bereits vorbei', 'Doppelt vorhanden', 'Sonstiges'];

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
  const [showReportModal, setShowReportModal] = useState(false);
  const [reportReason, setReportReason] = useState<string | null>(null);
  const [reportNote, setReportNote] = useState('');
  const [reportStatus, setReportStatus] = useState<'idle' | 'sending' | 'sent'>('idle');
  const { isFavorite, toggleFavorite } = useFavorites();

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

  // Bei einem direkt geöffneten Share-Link (z.B. aus WhatsApp) ist diese
  // Seite der erste und einzige Eintrag im Navigations-Stack — router.back()
  // hätte dann nichts, wohin es zurückgehen könnte, und der native Header
  // zeigt entsprechend gar keinen Zurück-Pfeil. Deshalb hier ein eigener,
  // immer sichtbarer Button, der in dem Fall stattdessen zur Startseite geht.
  function goBack() {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <TouchableOpacity style={styles.backBar} onPress={goBack}>
          <Text style={styles.backBarText}>‹ Übersicht</Text>
        </TouchableOpacity>
        <ActivityIndicator size="large" color="#fff" />
      </SafeAreaView>
    );
  }

  if (!event) {
    return (
      <SafeAreaView style={styles.center}>
        <TouchableOpacity style={styles.backBar} onPress={goBack}>
          <Text style={styles.backBarText}>‹ Übersicht</Text>
        </TouchableOpacity>
        <Text style={styles.errorText}>Event nicht gefunden.</Text>
      </SafeAreaView>
    );
  }

  const hasCoords = event.latitude !== null && event.longitude !== null;
  const hasImage = Boolean(event.image_url) && !imageFailed;

  function openInGoogleMaps() {
    if (!hasCoords) return;
    const query = [event!.location_name, event!.address]
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

  async function submitReport() {
    if (!reportReason) return;
    setReportStatus('sending');
    const { error } = await supabase
      .from('event_reports')
      .insert({ event_id: event!.id, reason: reportReason, note: reportNote || null });
    if (error) {
      console.error('Fehler beim Melden:', error);
      setReportStatus('idle');
      return;
    }
    setReportStatus('sent');
    setTimeout(() => {
      setShowReportModal(false);
      setReportStatus('idle');
      setReportReason(null);
      setReportNote('');
    }, 1200);
  }

  return (
    <SafeAreaView style={styles.container}>
      <TouchableOpacity style={styles.backBar} onPress={goBack}>
        <Text style={styles.backBarText}>‹ Übersicht</Text>
      </TouchableOpacity>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        {hasImage ? (
          <Image
            source={{ uri: event.image_url! }}
            style={styles.image}
            onError={() => setImageFailed(true)}
          />
        ) : (
          <LinearGradient
            colors={['#2a0a4a', '#12082e', '#000000']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.imageFallback}
          />
        )}

        <View style={styles.content}>
          <View style={styles.titleRow}>
            {event.category && <Text style={styles.badge}>{event.category}</Text>}
            <TouchableOpacity
              style={styles.favoriteBtn}
              onPress={() => toggleFavorite(event.id)}
            >
              <Text style={styles.favoriteBtnText}>{isFavorite(event.id) ? '❤️ Favorit' : '🤍 Merken'}</Text>
            </TouchableOpacity>
          </View>
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

          <TouchableOpacity style={styles.reportButton} onPress={() => setShowReportModal(true)}>
            <Text style={styles.reportButtonText}>🚩 Fehler melden</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      <Modal
        visible={showReportModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowReportModal(false)}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setShowReportModal(false)}
        >
          <TouchableOpacity activeOpacity={1} style={styles.modalCard} onPress={() => {}}>
            <Text style={styles.modalTitle}>Was stimmt nicht?</Text>

            {reportStatus === 'sent' ? (
              <Text style={styles.reportSentText}>✓ Danke, wird geprüft!</Text>
            ) : (
              <>
                <View style={styles.reasonWrap}>
                  {REPORT_REASONS.map((r) => (
                    <TouchableOpacity
                      key={r}
                      style={[styles.reasonChip, reportReason === r && styles.reasonChipActive]}
                      onPress={() => setReportReason(r)}
                    >
                      <Text style={[styles.reasonChipText, reportReason === r && styles.reasonChipTextActive]}>
                        {r}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <TextInput
                  style={styles.reportInput}
                  placeholder="Details (optional)"
                  placeholderTextColor="#666"
                  value={reportNote}
                  onChangeText={setReportNote}
                  multiline
                />
                <View style={styles.modalButtonRow}>
                  <TouchableOpacity
                    style={styles.modalSecondaryButton}
                    onPress={() => setShowReportModal(false)}
                  >
                    <Text style={styles.modalSecondaryButtonText}>Abbrechen</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.modalCloseButton, !reportReason && styles.modalCloseButtonDisabled]}
                    disabled={!reportReason || reportStatus === 'sending'}
                    onPress={submitReport}
                  >
                    <Text style={styles.modalCloseButtonText}>
                      {reportStatus === 'sending' ? '...' : 'Melden'}
                    </Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  scrollContent: { paddingBottom: 32 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' },
  errorText: { color: '#888', fontSize: 15 },
  backBar: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  backBarText: { color: '#0af', fontSize: 15, fontWeight: '600' },
  image: { width: '100%', aspectRatio: 16 / 9, backgroundColor: '#141414' },
  imageFallback: { width: '100%', aspectRatio: 3 },
  content: { padding: 16 },
  badge: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0af',
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  titleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  favoriteBtn: { paddingVertical: 2, paddingHorizontal: 4 },
  favoriteBtnText: { fontSize: 13, fontWeight: '600', color: '#fff' },
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
  reportButton: {
    alignItems: 'center',
    marginTop: 18,
    paddingVertical: 8,
  },
  reportButtonText: { color: '#666', fontWeight: '600', fontSize: 13 },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: '#0a0a0a',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 16,
    paddingBottom: 24,
  },
  modalTitle: { color: '#fff', fontSize: 18, fontWeight: '700', marginBottom: 14 },
  reasonWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
  reasonChip: {
    backgroundColor: '#141414',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  reasonChipActive: { backgroundColor: '#0af' },
  reasonChipText: { color: '#999', fontSize: 13, fontWeight: '600' },
  reasonChipTextActive: { color: '#000' },
  reportInput: {
    backgroundColor: '#141414',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#fff',
    fontSize: 16,
    minHeight: 70,
    textAlignVertical: 'top',
    marginBottom: 14,
  },
  reportSentText: { color: '#7cd992', fontSize: 16, fontWeight: '600', textAlign: 'center', paddingVertical: 20 },
  modalButtonRow: { flexDirection: 'row', gap: 10 },
  modalSecondaryButton: {
    flex: 1,
    backgroundColor: '#141414',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  modalSecondaryButtonText: { color: '#999', fontWeight: '600' },
  modalCloseButton: {
    flex: 1,
    backgroundColor: '#0af',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  modalCloseButtonDisabled: { backgroundColor: '#0af6' },
  modalCloseButtonText: { color: '#000', fontWeight: '700' },
});
