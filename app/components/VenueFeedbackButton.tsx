import { useState } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, TextInput, Modal } from 'react-native';
import { supabase } from '../lib/supabase';
import { registerStrings, useTranslation } from '../lib/strings';

registerStrings({
  'venueFeedback.link': { de: 'Feedback geben', en: 'Give feedback' },
  'venueFeedback.modalTitle': { de: 'Was stimmt nicht (mehr)?', en: "What's wrong (or missing)?" },
  'venueFeedback.reason.outdated': { de: 'Daten veraltet', en: 'Data outdated' },
  'venueFeedback.reason.beerPrice': { de: 'Bierpreis hinzufügen/aktualisieren', en: 'Add/update beer price' },
  'venueFeedback.reason.hours': { de: 'Öffnungszeiten falsch', en: 'Opening hours wrong' },
  'venueFeedback.reason.other': { de: 'Sonstiges', en: 'Other' },
  'venueFeedback.notePlaceholder': { de: 'Details (optional)', en: 'Details (optional)' },
  'venueFeedback.cancel': { de: 'Abbrechen', en: 'Cancel' },
  'venueFeedback.send': { de: 'Melden', en: 'Report' },
  'venueFeedback.sent': { de: '✓ Danke, wird geprüft!', en: "✓ Thanks, we'll take a look!" },
});

// value bleibt Deutsch (an die DB gesendeter Wert) — nur labelKey wird
// übersetzt angezeigt, gleiches Prinzip wie REPORT_REASONS in
// app/event/[id].tsx (event_reports-Pendant für Venues, siehe
// supabase/migrations/0027_venue_reports.sql).
const REASONS: { value: string; labelKey: string }[] = [
  { value: 'Daten veraltet', labelKey: 'venueFeedback.reason.outdated' },
  { value: 'Bierpreis hinzufügen/aktualisieren', labelKey: 'venueFeedback.reason.beerPrice' },
  { value: 'Öffnungszeiten falsch', labelKey: 'venueFeedback.reason.hours' },
  { value: 'Sonstiges', labelKey: 'venueFeedback.reason.other' },
];

export default function VenueFeedbackButton({ venueId }: { venueId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent'>('idle');

  function reset() {
    setReason(null);
    setNote('');
    setStatus('idle');
  }

  async function submit() {
    if (!reason) return;
    setStatus('sending');
    const { error } = await supabase.from('venue_reports').insert({ venue_id: venueId, reason, note: note || null });
    if (error) {
      console.error('Fehler beim Melden:', error);
      setStatus('idle');
      return;
    }
    setStatus('sent');
    setTimeout(() => {
      setOpen(false);
      reset();
    }, 1200);
  }

  return (
    <>
      <TouchableOpacity
        style={styles.link}
        onPress={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <Text style={styles.linkText}>{t('venueFeedback.link')}</Text>
      </TouchableOpacity>

      <Modal visible={open} animationType="slide" transparent onRequestClose={() => setOpen(false)}>
        <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={() => setOpen(false)}>
          <TouchableOpacity activeOpacity={1} style={styles.card} onPress={() => {}}>
            <Text style={styles.title}>{t('venueFeedback.modalTitle')}</Text>
            {status === 'sent' ? (
              <Text style={styles.sentText}>{t('venueFeedback.sent')}</Text>
            ) : (
              <>
                <View style={styles.reasonWrap}>
                  {REASONS.map((r) => (
                    <TouchableOpacity
                      key={r.value}
                      style={[styles.reasonChip, reason === r.value && styles.reasonChipActive]}
                      onPress={() => setReason(r.value)}
                    >
                      <Text style={[styles.reasonChipText, reason === r.value && styles.reasonChipTextActive]}>
                        {t(r.labelKey)}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <TextInput
                  style={styles.input}
                  placeholder={t('venueFeedback.notePlaceholder')}
                  placeholderTextColor="#666"
                  value={note}
                  onChangeText={setNote}
                  multiline
                />
                <View style={styles.buttonRow}>
                  <TouchableOpacity style={styles.secondaryButton} onPress={() => setOpen(false)}>
                    <Text style={styles.secondaryButtonText}>{t('venueFeedback.cancel')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.primaryButton, !reason && styles.primaryButtonDisabled]}
                    disabled={!reason || status === 'sending'}
                    onPress={submit}
                  >
                    <Text style={styles.primaryButtonText}>
                      {status === 'sending' ? '...' : t('venueFeedback.send')}
                    </Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  link: { alignSelf: 'flex-start' },
  linkText: { color: '#555', fontSize: 12 },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  card: { backgroundColor: '#0a0a0a', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 16, paddingBottom: 24 },
  title: { color: '#fff', fontSize: 18, fontWeight: '700', marginBottom: 14 },
  reasonWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
  reasonChip: { backgroundColor: '#141414', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 9 },
  reasonChipActive: { backgroundColor: '#0af' },
  reasonChipText: { color: '#999', fontSize: 13, fontWeight: '600' },
  reasonChipTextActive: { color: '#000' },
  input: {
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
  sentText: { color: '#7cd992', fontSize: 16, fontWeight: '600', textAlign: 'center', paddingVertical: 20 },
  buttonRow: { flexDirection: 'row', gap: 10 },
  secondaryButton: { flex: 1, backgroundColor: '#141414', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  secondaryButtonText: { color: '#999', fontWeight: '600' },
  primaryButton: { flex: 1, backgroundColor: '#0af', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  primaryButtonDisabled: { backgroundColor: '#0af6' },
  primaryButtonText: { color: '#000', fontWeight: '700' },
});
