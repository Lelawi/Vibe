import { useState } from 'react';
import { Modal, View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { registerStrings, useTranslation } from '../lib/strings';
import { lookupPostalCode, type PostalCodeLocation } from '../lib/postalCodes';
import { canUseGps, type LocationPreference } from '../lib/locationPreference';

registerStrings({
  'locationPicker.title': { de: 'Standort für „Nähe"', en: 'Location for "Nearby"' },
  'locationPicker.subtitle': {
    de: 'Gib eine Postleitzahl ein, wenn du deinen Standort nicht teilen willst. Die PLZ bleibt auf deinem Gerät.',
    en: "Enter a postal code if you'd rather not share your location. It stays on your device.",
  },
  'locationPicker.placeholder': { de: 'PLZ, z.B. 80331', en: 'Postal code, e.g. 80331' },
  'locationPicker.apply': { de: 'Übernehmen', en: 'Apply' },
  'locationPicker.unknown': {
    de: 'Diese PLZ kennen wir nicht — Vibe deckt bisher München und Umgebung ab.',
    en: "We don't know this postal code — Vibe currently covers Munich and surroundings.",
  },
  'locationPicker.or': { de: 'oder', en: 'or' },
  'locationPicker.useGps': { de: 'Aktuellen Standort verwenden', en: 'Use current location' },
  'locationPicker.gpsActive': { de: 'Aktueller Standort (aktiv)', en: 'Current location (active)' },
  'locationPicker.gpsDenied': {
    de: 'Standort nicht verfügbar — erlaube den Standortzugriff im Browser oder gib eine PLZ ein.',
    en: 'Location unavailable — allow location access in your browser or enter a postal code.',
  },
  'locationPicker.gpsLabel': { de: 'Aktueller Standort', en: 'Current location' },
  'locationPicker.clear': { de: 'Zurücksetzen', en: 'Reset' },
});

export function formatLocationPreference(pref: LocationPreference | null, t: (key: string) => string): string | null {
  if (!pref) return null;
  return pref.mode === 'postalCode' ? `${pref.postalCode} ${pref.label}` : t('locationPicker.gpsLabel');
}

type Props = {
  visible: boolean;
  onClose: () => void;
  onUseGps: () => void;
  onUsePostalCode: (location: PostalCodeLocation) => void;
  onClear?: () => void;
  preference: LocationPreference | null;
  gpsDenied?: boolean;
};

// Auswahl der Standort-Quelle für den "Nähe"-Filter: PLZ (ohne
// Standortfreigabe) oder Browser-Standort. Genutzt von der Eventliste, den
// Venue-Listen und den Einstellungen (dort mit onClear).
//
// Erst beim Öffnen gemountet statt dauerhaft mit visible=false: react-native-
// web hängt jedes <Modal> schon beim Mounten als eigenes Element an <body>,
// alle mit demselben zIndex — die DOM-Reihenfolge entscheidet. Dauerhaft
// gemountet lag der Dialog deshalb unter dem früher geöffneten Filter-Sheet
// der Eventliste, aus dem heraus "Nähe" ihn öffnet (per Nutzer-Feedback,
// 2026-10-12). So landet er beim Öffnen als letztes Element ganz oben.
export default function LocationPickerModal(props: Props) {
  return props.visible ? <LocationPickerSheet {...props} /> : null;
}

function LocationPickerSheet({ onClose, onUseGps, onUsePostalCode, onClear, preference, gpsDenied = false }: Props) {
  const { t } = useTranslation();
  const [input, setInput] = useState(preference?.mode === 'postalCode' ? preference.postalCode : '');
  const [showError, setShowError] = useState(false);

  const digits = input.replace(/\D/g, '');
  const match = digits.length === 5 ? lookupPostalCode(digits) : null;

  function apply() {
    if (!match) {
      setShowError(true);
      return;
    }
    onUsePostalCode(match);
  }

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={styles.card} onPress={() => {}}>
          <View style={styles.headerRow}>
            <Text style={styles.title}>{t('locationPicker.title')}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <Ionicons name="close" size={22} color="#888" />
            </TouchableOpacity>
          </View>
          <Text style={styles.subtitle}>{t('locationPicker.subtitle')}</Text>

          {gpsDenied && <Text style={styles.deniedText}>{t('locationPicker.gpsDenied')}</Text>}

          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              value={input}
              onChangeText={(text) => {
                setInput(text.replace(/\D/g, '').slice(0, 5));
                setShowError(false);
              }}
              placeholder={t('locationPicker.placeholder')}
              placeholderTextColor="#666"
              keyboardType="number-pad"
              inputMode="numeric"
              autoComplete="postal-code"
              maxLength={5}
              onSubmitEditing={apply}
              returnKeyType="done"
            />
            <TouchableOpacity
              style={[styles.applyButton, !match && styles.applyButtonDisabled]}
              onPress={apply}
            >
              <Text style={[styles.applyButtonText, !match && styles.applyButtonTextDisabled]}>
                {t('locationPicker.apply')}
              </Text>
            </TouchableOpacity>
          </View>
          {match ? (
            <Text style={styles.matchText}>
              <Ionicons name="location" size={13} color="#0af" /> {match.postalCode} {match.label}
            </Text>
          ) : (showError || digits.length === 5) && (
            <Text style={styles.errorText}>{t('locationPicker.unknown')}</Text>
          )}

          {canUseGps() && (
            <>
              <View style={styles.dividerRow}>
                <View style={styles.dividerLine} />
                <Text style={styles.dividerText}>{t('locationPicker.or')}</Text>
                <View style={styles.dividerLine} />
              </View>
              <TouchableOpacity
                style={[styles.gpsButton, preference?.mode === 'gps' && styles.gpsButtonActive]}
                onPress={onUseGps}
              >
                <Ionicons name="navigate-outline" size={18} color={preference?.mode === 'gps' ? '#0af' : '#fff'} />
                <Text style={styles.gpsButtonText}>
                  {preference?.mode === 'gps' ? t('locationPicker.gpsActive') : t('locationPicker.useGps')}
                </Text>
              </TouchableOpacity>
            </>
          )}

          {onClear && preference && (
            <TouchableOpacity style={styles.clearButton} onPress={onClear}>
              <Text style={styles.clearButtonText}>{t('locationPicker.clear')}</Text>
            </TouchableOpacity>
          )}
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  card: {
    backgroundColor: '#0a0a0a',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 16,
    paddingBottom: 28,
    paddingHorizontal: 20,
  },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  title: { color: '#fff', fontSize: 18, fontWeight: '700', flexShrink: 1 },
  subtitle: { color: '#888', fontSize: 13, marginBottom: 14, lineHeight: 18 },
  deniedText: { color: '#f90', fontSize: 13, marginBottom: 12, lineHeight: 18 },
  inputRow: { flexDirection: 'row', gap: 10 },
  input: {
    flex: 1,
    backgroundColor: '#141414',
    color: '#fff',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#222',
  },
  applyButton: { backgroundColor: '#0af', borderRadius: 10, paddingHorizontal: 16, justifyContent: 'center' },
  applyButtonDisabled: { backgroundColor: '#1d1d1d' },
  applyButtonText: { color: '#000', fontWeight: '700', fontSize: 15 },
  applyButtonTextDisabled: { color: '#666' },
  matchText: { color: '#ccc', fontSize: 13, marginTop: 8 },
  errorText: { color: '#f66', fontSize: 13, marginTop: 8, lineHeight: 18 },
  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 16 },
  dividerLine: { flex: 1, height: 1, backgroundColor: '#222' },
  dividerText: { color: '#666', fontSize: 12 },
  gpsButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#141414',
    borderRadius: 10,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: '#222',
  },
  gpsButtonActive: { borderColor: '#0af' },
  gpsButtonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  clearButton: { alignSelf: 'center', marginTop: 16, padding: 6 },
  clearButtonText: { color: '#888', fontSize: 13, textDecorationLine: 'underline' },
});
