import { useState } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, TextInput, Modal, Image, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { registerStrings, useTranslation } from '../lib/strings';
import { pickScreenshot, submitFeedback, submitMissingItem } from '../lib/feedback';

registerStrings({
  'feedback.button': { de: 'Feedback', en: 'Feedback' },
  'feedback.title': { de: 'Feedback geben', en: 'Send feedback' },
  'feedback.placeholder': {
    de: 'Was ist dir aufgefallen? Bug, Idee, Lob — alles willkommen.',
    en: 'What did you notice? Bug, idea, praise — all welcome.',
  },
  'feedback.attach': { de: 'Screenshot anhängen', en: 'Attach screenshot' },
  'feedback.aiNotice': {
    de: 'Text und Screenshot werden automatisch analysiert, um eindeutige Hinweise direkt zu prüfen. Bilder werden privat gespeichert und nach der Bearbeitung gelöscht.',
    en: 'Text and screenshot are analyzed automatically to verify clear reports. Images are stored privately and deleted after processing.',
  },
  'feedback.remove': { de: 'Entfernen', en: 'Remove' },
  'feedback.send': { de: 'Absenden', en: 'Send' },
  'feedback.sending': { de: 'Wird gesendet…', en: 'Sending…' },
  'feedback.success': { de: 'Danke für dein Feedback!', en: 'Thanks for your feedback!' },
  'feedback.error': { de: 'Senden fehlgeschlagen. Nochmal versuchen?', en: 'Sending failed. Try again?' },
  'feedback.cancel': { de: 'Abbrechen', en: 'Cancel' },
  'feedback.mode.general': { de: 'Allgemein', en: 'General' },
  'feedback.mode.event': { de: 'Event fehlt', en: 'Missing event' },
  'feedback.mode.location': { de: 'Location fehlt', en: 'Missing location' },
  'feedback.name': { de: 'Name *', en: 'Name *' },
  'feedback.date': { de: 'Datum (JJJJ-MM-TT)', en: 'Date (YYYY-MM-DD)' },
  'feedback.location': { de: 'Location / Adresse', en: 'Location / address' },
  'feedback.url': { de: 'Webseite / Event-URL', en: 'Website / event URL' },
  'feedback.note': { de: 'Weitere Hinweise (optional)', en: 'Additional notes (optional)' },
});

type FeedbackMode = 'general' | 'event' | 'location';

export default function FeedbackButton() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [mode, setMode] = useState<FeedbackMode>('general');
  const [name, setName] = useState('');
  const [eventDate, setEventDate] = useState('');
  const [location, setLocation] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [screenshotPreview, setScreenshotPreview] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');

  function reset() {
    setMessage('');
    setMode('general');
    setName('');
    setEventDate('');
    setLocation('');
    setSourceUrl('');
    setScreenshot(null);
    setScreenshotPreview(null);
    setStatus('idle');
  }

  async function handleAttach() {
    const file = await pickScreenshot();
    if (!file) return;
    setScreenshot(file);
    setScreenshotPreview(URL.createObjectURL(file));
  }

  async function handleSubmit() {
    if ((mode === 'general' ? !message.trim() : !name.trim()) || status === 'sending') return;
    setStatus('sending');
    const pageContext = Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.pathname : 'native';
    const result = mode === 'general'
      ? await submitFeedback(message.trim(), screenshot, pageContext)
      : await submitMissingItem({
          kind: mode,
          name,
          eventDate,
          location,
          sourceUrl,
          note: message,
          pageContext,
        });
    setStatus(result.ok ? 'success' : 'error');
  }

  return (
    <>
      <TouchableOpacity style={styles.button} onPress={() => setOpen(true)}>
        <Ionicons name="chatbubble-ellipses-outline" size={16} color="#fff" />
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={styles.overlay}>
          <View style={styles.card}>
            {status === 'success' ? (
              <>
                <Ionicons name="checkmark-circle" size={40} color="#4ade80" style={styles.successIcon} />
                <Text style={styles.successText}>{t('feedback.success')}</Text>
                <TouchableOpacity
                  style={styles.primaryBtn}
                  onPress={() => {
                    reset();
                    setOpen(false);
                  }}
                >
                  <Text style={styles.primaryBtnText}>OK</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <Text style={styles.title}>{t('feedback.title')}</Text>
                <View style={styles.modeRow}>
                  {(['general', 'event', 'location'] as FeedbackMode[]).map((item) => (
                    <TouchableOpacity
                      key={item}
                      style={[styles.modeChip, mode === item && styles.modeChipActive]}
                      onPress={() => { setMode(item); setStatus('idle'); }}
                    >
                      <Text style={[styles.modeChipText, mode === item && styles.modeChipTextActive]}>
                        {t(`feedback.mode.${item}`)}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {mode !== 'general' && (
                  <>
                    <TextInput style={styles.compactInput} placeholder={t('feedback.name')} placeholderTextColor="#666" value={name} onChangeText={setName} />
                    {mode === 'event' && (
                      <TextInput style={styles.compactInput} placeholder={t('feedback.date')} placeholderTextColor="#666" value={eventDate} onChangeText={setEventDate} />
                    )}
                    <TextInput style={styles.compactInput} placeholder={t('feedback.location')} placeholderTextColor="#666" value={location} onChangeText={setLocation} />
                    <TextInput style={styles.compactInput} placeholder={t('feedback.url')} placeholderTextColor="#666" value={sourceUrl} onChangeText={setSourceUrl} autoCapitalize="none" keyboardType="url" />
                  </>
                )}
                <TextInput
                  style={[styles.input, mode !== 'general' && styles.noteInput]}
                  placeholder={mode === 'general' ? t('feedback.placeholder') : t('feedback.note')}
                  placeholderTextColor="#666"
                  value={message}
                  onChangeText={setMessage}
                  multiline
                  numberOfLines={mode === 'general' ? 5 : 3}
                />
                {mode === 'general' && (screenshotPreview ? (
                  <View style={styles.previewWrap}>
                    <Image source={{ uri: screenshotPreview }} style={styles.preview} />
                    <TouchableOpacity
                      onPress={() => {
                        setScreenshot(null);
                        setScreenshotPreview(null);
                      }}
                    >
                      <Text style={styles.removeLink}>{t('feedback.remove')}</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <TouchableOpacity style={styles.attachBtn} onPress={handleAttach}>
                    <Ionicons name="image-outline" size={16} color="#0af" />
                    <Text style={styles.attachBtnText}>{t('feedback.attach')}</Text>
                  </TouchableOpacity>
                ))}

                {mode === 'general' && <Text style={styles.aiNotice}>{t('feedback.aiNotice')}</Text>}

                {status === 'error' && <Text style={styles.errorText}>{t('feedback.error')}</Text>}

                <View style={styles.actionsRow}>
                  <TouchableOpacity
                    style={styles.cancelBtn}
                    onPress={() => {
                      reset();
                      setOpen(false);
                    }}
                  >
                    <Text style={styles.cancelBtnText}>{t('feedback.cancel')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.primaryBtn, ((mode === 'general' ? !message.trim() : !name.trim()) || status === 'sending') && styles.primaryBtnDisabled]}
                    onPress={handleSubmit}
                    disabled={(mode === 'general' ? !message.trim() : !name.trim()) || status === 'sending'}
                  >
                    <Text style={styles.primaryBtnText}>
                      {status === 'sending' ? t('feedback.sending') : t('feedback.send')}
                    </Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  button: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 14,
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.65)', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: '#141414', borderRadius: 20, padding: 20, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },
  title: { fontSize: 18, fontWeight: '800', color: '#fff', marginBottom: 14 },
  modeRow: { flexDirection: 'row', gap: 7, marginBottom: 12, flexWrap: 'wrap' },
  modeChip: { borderRadius: 16, paddingHorizontal: 11, paddingVertical: 7, backgroundColor: '#222' },
  modeChipActive: { backgroundColor: '#0af' },
  modeChipText: { color: '#aaa', fontSize: 12, fontWeight: '700' },
  modeChipTextActive: { color: '#000' },
  compactInput: {
    backgroundColor: '#0a0a0a', borderRadius: 12, paddingHorizontal: 12,
    paddingVertical: 10, color: '#fff', fontSize: 14, marginBottom: 8,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
  },
  input: {
    backgroundColor: '#0a0a0a',
    borderRadius: 14,
    padding: 12,
    color: '#fff',
    fontSize: 15,
    minHeight: 110,
    textAlignVertical: 'top',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  noteInput: { minHeight: 72 },
  attachBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 12,
    alignSelf: 'flex-start',
  },
  attachBtnText: { color: '#0af', fontSize: 14, fontWeight: '600' },
  previewWrap: { marginTop: 12, alignItems: 'flex-start', gap: 6 },
  preview: { width: 120, height: 120, borderRadius: 12, backgroundColor: '#000' },
  removeLink: { color: '#ff6b6b', fontSize: 13, fontWeight: '600' },
  errorText: { color: '#ff6b6b', fontSize: 13, marginTop: 10 },
  aiNotice: { color: '#777', fontSize: 11, lineHeight: 16, marginTop: 12 },
  actionsRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 18 },
  cancelBtn: { paddingVertical: 12, paddingHorizontal: 16 },
  cancelBtnText: { color: '#888', fontSize: 14, fontWeight: '600' },
  primaryBtn: { backgroundColor: '#0af', borderRadius: 22, paddingVertical: 12, paddingHorizontal: 20 },
  primaryBtnDisabled: { opacity: 0.4 },
  primaryBtnText: { color: '#000', fontSize: 14, fontWeight: '800' },
  successIcon: { alignSelf: 'center', marginBottom: 10 },
  successText: { color: '#fff', fontSize: 16, fontWeight: '700', textAlign: 'center', marginBottom: 16 },
});
