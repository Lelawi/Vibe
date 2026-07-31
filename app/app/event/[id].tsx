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
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { addEventToCalendar } from '../../lib/calendar';
import { shareEvent } from '../../lib/share';
import { useFavorites } from '../../lib/favorites';
import { useFollowedOrganizers } from '../../lib/followedOrganizers';
import { isPushSupported } from '../../lib/pushNotifications';
import { registerStrings, useTranslation } from '../../lib/strings';
import { categoryLabel } from '../../lib/eventCategories';
import type { Language } from '../../lib/language';

registerStrings({
  'event.back': { de: '‹ Übersicht', en: '‹ Overview' },
  'event.notFound': { de: 'Event nicht gefunden.', en: 'Event not found.' },
  'event.ticketPage': { de: 'Zur Ticketseite', en: 'Go to ticket page' },
  'event.openInGoogleMaps': { de: 'In Google Maps öffnen', en: 'Open in Google Maps' },
  'event.favorited': { de: 'Favorit', en: 'Favorited' },
  'event.favorite': { de: 'Merken', en: 'Save' },
  'event.when': { de: 'Wann', en: 'When' },
  'event.until': { de: 'bis', en: 'until' },
  'event.price': { de: 'Preis', en: 'Price' },
  'event.noPriceInfo': { de: 'Keine Preisinfo verfügbar', en: 'No price info available' },
  'event.soldOut': { de: 'Ausverkauft', en: 'Sold out' },
  'event.where': { de: 'Wo', en: 'Where' },
  'event.genre': { de: 'Genre', en: 'Genre' },
  'event.organizer': { de: 'Veranstalter', en: 'Organizer' },
  'event.following': { de: 'Gefolgt', en: 'Following' },
  'event.follow': { de: 'Folgen', en: 'Follow' },
  'event.moreFrom': { de: 'Weitere Events von', en: 'More events from' },
  'event.description': { de: 'Beschreibung', en: 'Description' },
  'event.linkCopied': { de: 'Link kopiert', en: 'Link copied' },
  'event.share': { de: 'Teilen', en: 'Share' },
  'event.saveToCalendar': { de: 'In Kalender speichern', en: 'Save to calendar' },
  'event.reportError': { de: 'Fehler melden', en: 'Report an issue' },
  'event.reportModalTitle': { de: 'Was stimmt nicht?', en: "What's wrong?" },
  'event.reportSent': { de: '✓ Danke, wird geprüft!', en: "✓ Thanks, we'll take a look!" },
  'event.reportNotePlaceholder': { de: 'Details (optional)', en: 'Details (optional)' },
  'event.cancel': { de: 'Abbrechen', en: 'Cancel' },
  'event.report': { de: 'Melden', en: 'Report' },
  'event.reportReason.address': { de: 'Ort/Adresse falsch', en: 'Location/address wrong' },
  'event.reportReason.datetime': { de: 'Datum/Uhrzeit falsch', en: 'Date/time wrong' },
  'event.reportReason.past': { de: 'Bereits vorbei', en: 'Already happened' },
  'event.reportReason.duplicate': { de: 'Doppelt vorhanden', en: 'Duplicate entry' },
  'event.reportReason.other': { de: 'Sonstiges', en: 'Other' },
});

// value bleibt Deutsch (an die DB gesendeter Wert, siehe submitReport) —
// nur labelKey wird je nach Sprache übersetzt angezeigt, damit sich am
// gespeicherten Datenformat/an der bestehenden manuellen Review-Auswertung
// nichts ändert.
const REPORT_REASONS: { value: string; labelKey: string }[] = [
  { value: 'Ort/Adresse falsch', labelKey: 'event.reportReason.address' },
  { value: 'Datum/Uhrzeit falsch', labelKey: 'event.reportReason.datetime' },
  { value: 'Bereits vorbei', labelKey: 'event.reportReason.past' },
  { value: 'Doppelt vorhanden', labelKey: 'event.reportReason.duplicate' },
  { value: 'Sonstiges', labelKey: 'event.reportReason.other' },
];

type EventDetail = {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  subcategory: string | null;
  start_date: string;
  start_time: string | null;
  end_date: string | null;
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

function formatDate(dateStr: string, timeStr: string | null, lang: Language) {
  const date = new Date(`${dateStr}T${timeStr ?? '00:00'}`);
  const dateFormatted = date.toLocaleDateString(lang === 'de' ? 'de-DE' : 'en-GB', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });
  if (!timeStr) return dateFormatted;
  return lang === 'de' ? `${dateFormatted} · ${timeStr.slice(0, 5)} Uhr` : `${dateFormatted} · ${timeStr.slice(0, 5)}`;
}

function formatEndDate(dateStr: string, lang: Language) {
  return new Date(`${dateStr}T00:00`).toLocaleDateString(lang === 'de' ? 'de-DE' : 'en-GB', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });
}

export default function EventDetailScreen() {
  const { t, language } = useTranslation();
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
  const { isFollowing, toggleFollow } = useFollowedOrganizers();

  useEffect(() => {
    async function loadEvent() {
      const { data, error } = await supabase
        .from('events')
        .select(
          'id, title, description, category, subcategory, start_date, start_time, end_date, location_name, address, organizer, source_url, image_url, price_info, sold_out, latitude, longitude'
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
          <Text style={styles.backBarText}>{t('event.back')}</Text>
        </TouchableOpacity>
        <ActivityIndicator size="large" color="#fff" />
      </SafeAreaView>
    );
  }

  if (!event) {
    return (
      <SafeAreaView style={styles.center}>
        <TouchableOpacity style={styles.backBar} onPress={goBack}>
          <Text style={styles.backBarText}>{t('event.back')}</Text>
        </TouchableOpacity>
        <Text style={styles.errorText}>{t('event.notFound')}</Text>
      </SafeAreaView>
    );
  }

  const hasCoords = event.latitude !== null && event.longitude !== null;
  const hasImage = Boolean(event.image_url) && !imageFailed;
  // Primäre Aktion wird als persistente Leiste am unteren Bildschirmrand
  // hervorgehoben (nach dem Vorbild von Posh's "Buy tickets"-Leiste) statt
  // als einer von fünf gleich aussehenden Buttons im Scroll-Inhalt unterzugehen.
  // Ohne Quell-URL übernimmt "In Google Maps öffnen" diese Rolle, sonst bleibt
  // es unten als normaler Sekundär-Button stehen.
  // key statt direkt des übersetzten Labels — wird weiter unten sowohl für
  // die Anzeige (übersetzt) als auch als stabiler Vergleichswert genutzt
  // (z.B. um den doppelten "In Google Maps öffnen"-Sekundärbutton zu
  // vermeiden, wenn Maps schon die primäre Aktion ist).
  const primaryAction: { key: 'ticket' | 'maps'; onPress: () => void } | null = event.source_url
    ? { key: 'ticket', onPress: () => Linking.openURL(event.source_url!) }
    : hasCoords
    ? { key: 'maps', onPress: () => openInGoogleMaps() }
    : null;

  // Koordinaten+Label statt Namens-/Adress-Freitextsuche: gleicher Grund wie
  // googleMapsUrl in VenueListScreen.tsx/VenueLeafletView.web.tsx — bei
  // Veranstaltungsorten, die auch Filialketten sind, lieferte die
  // Freitextsuche mehrere Treffer statt direkt zum richtigen Ort zu springen.
  function openInGoogleMaps() {
    if (!hasCoords) return;
    const label = [event!.location_name, event!.address].filter(Boolean).join(', ').trim();
    const url = label
      ? `https://www.google.com/maps?q=${event!.latitude},${event!.longitude}(${encodeURIComponent(label)})`
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
            {event.category && <Text style={styles.badge}>{categoryLabel(event.category, language)}</Text>}
            <TouchableOpacity
              style={styles.favoriteBtn}
              onPress={() => toggleFavorite(event.id)}
            >
              <Ionicons
                name={isFavorite(event.id) ? 'heart' : 'heart-outline'}
                size={16}
                color={isFavorite(event.id) ? '#ff4d6d' : '#fff'}
              />
              <Text style={styles.favoriteBtnText}>{isFavorite(event.id) ? t('event.favorited') : t('event.favorite')}</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.title}>{event.title}</Text>

          <View style={styles.infoBlock}>
            <Text style={styles.infoLabel}>{t('event.when')}</Text>
            <Text style={styles.infoValue}>
              {formatDate(event.start_date, event.start_time, language)}
            </Text>
            {event.end_date && event.end_date !== event.start_date ? (
              <Text style={styles.infoValue}>{t('event.until')} {formatEndDate(event.end_date, language)}</Text>
            ) : null}
          </View>

          {(event.price_info || event.sold_out !== null) && (
            <View style={styles.infoBlock}>
              <Text style={styles.infoLabel}>{t('event.price')}</Text>
              <View style={styles.priceRow}>
                <Text style={styles.infoValue}>{event.price_info ?? t('event.noPriceInfo')}</Text>
                {event.sold_out === true && (
                  <View style={styles.soldOutTag}>
                    <Ionicons name="close-circle" size={13} color="#ff4d4d" />
                    <Text style={styles.soldOutTagText}>{t('event.soldOut')}</Text>
                  </View>
                )}
              </View>
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
              <Text style={styles.infoLabel}>{t('event.where')}</Text>
              <View style={styles.locationValueRow}>
                <Text style={[styles.infoValue, hasCoords && styles.linkValue]}>{event.location_name}</Text>
                {hasCoords && <Ionicons name="location-outline" size={15} color="#0af" />}
              </View>
              {event.address && <Text style={styles.infoSubValue}>{event.address}</Text>}
            </TouchableOpacity>
          )}

          {event.subcategory && (
            <View style={styles.infoBlock}>
              <Text style={styles.infoLabel}>{t('event.genre')}</Text>
              <Text style={styles.infoValue}>{event.subcategory}</Text>
            </View>
          )}

          {event.organizer && (
            <View style={styles.infoBlock}>
              <Text style={styles.infoLabel}>{t('event.organizer')}</Text>
              <View style={styles.organizerRow}>
                <Text style={styles.infoValue}>{event.organizer}</Text>
                {isPushSupported() && (
                  <TouchableOpacity style={styles.organizerFollowBtn} onPress={() => toggleFollow(event.organizer!)}>
                    <Ionicons
                      name={isFollowing(event.organizer) ? 'notifications' : 'notifications-off-outline'}
                      size={13}
                      color="#0af"
                    />
                    <Text style={styles.organizerFollowLink}>
                      {isFollowing(event.organizer) ? t('event.following') : t('event.follow')}
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
              <TouchableOpacity
                onPress={() => router.push({ pathname: '/', params: { search: event.organizer! } })}
              >
                <Text style={styles.organizerMoreLink}>{t('event.moreFrom')} {event.organizer} →</Text>
              </TouchableOpacity>
            </View>
          )}

          {event.description && (
            <View style={styles.infoBlock}>
              <Text style={styles.infoLabel}>{t('event.description')}</Text>
              <Text style={styles.infoValue}>{event.description}</Text>
            </View>
          )}

          <TouchableOpacity style={styles.secondaryButton} onPress={handleShare}>
            <Ionicons
              name={shareStatus === 'copied' ? 'checkmark' : 'share-social-outline'}
              size={16}
              color="#fff"
            />
            <Text style={styles.secondaryButtonText}>
              {shareStatus === 'copied' ? t('event.linkCopied') : t('event.share')}
            </Text>
          </TouchableOpacity>

          {/* "In Google Maps öffnen" nur als Sekundär-Button, wenn die
              Ticketseite bereits die primäre Aktion in der unteren Leiste
              ist — sonst würde Maps doppelt auftauchen. */}
          {hasCoords && primaryAction?.key !== 'maps' && (
            <TouchableOpacity style={styles.secondaryButton} onPress={openInGoogleMaps}>
              <Ionicons name="map-outline" size={16} color="#fff" />
              <Text style={styles.secondaryButtonText}>{t('event.openInGoogleMaps')}</Text>
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
            <Ionicons name="calendar-outline" size={16} color="#fff" />
            <Text style={styles.secondaryButtonText}>{t('event.saveToCalendar')}</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.reportButton} onPress={() => setShowReportModal(true)}>
            <Ionicons name="flag-outline" size={13} color="#666" />
            <Text style={styles.reportButtonText}>{t('event.reportError')}</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      {primaryAction && (
        <View style={styles.primaryActionBar}>
          <TouchableOpacity style={styles.primaryActionButton} onPress={primaryAction.onPress}>
            <Text style={styles.primaryActionButtonText}>
              {t(primaryAction.key === 'ticket' ? 'event.ticketPage' : 'event.openInGoogleMaps')}
              {primaryAction.key === 'ticket' && event.price_info ? ` · ${event.price_info}` : ''}
            </Text>
          </TouchableOpacity>
        </View>
      )}

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
            <Text style={styles.modalTitle}>{t('event.reportModalTitle')}</Text>

            {reportStatus === 'sent' ? (
              <Text style={styles.reportSentText}>{t('event.reportSent')}</Text>
            ) : (
              <>
                <View style={styles.reasonWrap}>
                  {REPORT_REASONS.map((r) => (
                    <TouchableOpacity
                      key={r.value}
                      style={[styles.reasonChip, reportReason === r.value && styles.reasonChipActive]}
                      onPress={() => setReportReason(r.value)}
                    >
                      <Text style={[styles.reasonChipText, reportReason === r.value && styles.reasonChipTextActive]}>
                        {t(r.labelKey)}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <TextInput
                  style={styles.reportInput}
                  placeholder={t('event.reportNotePlaceholder')}
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
                    <Text style={styles.modalSecondaryButtonText}>{t('event.cancel')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.modalCloseButton, !reportReason && styles.modalCloseButtonDisabled]}
                    disabled={!reportReason || reportStatus === 'sending'}
                    onPress={submitReport}
                  >
                    <Text style={styles.modalCloseButtonText}>
                      {reportStatus === 'sending' ? '...' : t('event.report')}
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
  scrollContent: { paddingBottom: 100 },
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
    color: '#5fd4ff',
    textTransform: 'uppercase',
    backgroundColor: 'rgba(0,170,255,0.14)',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginBottom: 8,
    alignSelf: 'flex-start',
    overflow: 'hidden',
  },
  titleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  favoriteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 2,
    paddingHorizontal: 4,
  },
  favoriteBtnText: { fontSize: 13, fontWeight: '600', color: '#fff' },
  title: { fontSize: 29, fontWeight: '800', color: '#fff', marginBottom: 20, lineHeight: 34 },
  infoBlock: {
    paddingBottom: 16,
    marginBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  infoLabel: { fontSize: 12, color: '#666', textTransform: 'uppercase', marginBottom: 4 },
  infoValue: { fontSize: 16, color: '#fff' },
  priceRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  soldOutTag: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  soldOutTagText: { color: '#ff4d4d', fontSize: 13, fontWeight: '700' },
  organizerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  organizerFollowBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  organizerFollowLink: { fontSize: 13, color: '#0af', fontWeight: '600' },
  organizerMoreLink: { fontSize: 13, color: '#0af', fontWeight: '600', marginTop: 6 },
  linkValue: { color: '#0af', fontWeight: '600' },
  locationValueRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
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
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#141414',
    borderRadius: 12,
    paddingVertical: 14,
    marginTop: 10,
  },
  secondaryButtonText: { color: '#fff', fontWeight: '600', fontSize: 15 },
  primaryActionBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: 16,
    backgroundColor: 'rgba(0,0,0,0.85)',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.08)',
  },
  primaryActionButton: {
    backgroundColor: '#0af',
    borderRadius: 30,
    paddingVertical: 16,
    alignItems: 'center',
    shadowColor: '#0af',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 4,
  },
  primaryActionButtonText: { color: '#000', fontWeight: '800', fontSize: 16 },
  reportButton: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 6,
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
