import { Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useTranslation } from '../lib/strings';

// Kleiner DE/EN-Umschalter fürs Banner-Header (index.tsx, VenueListScreen.tsx)
// — zeigt die Sprache, in die beim Antippen gewechselt wird (nicht die
// aktuell aktive), gleiches Prinzip wie ein Play/Pause-Icon: der Button
// zeigt die nächste Aktion, nicht den aktuellen Zustand.
export default function LanguageToggle() {
  const { language, toggleLanguage } = useTranslation();
  return (
    <TouchableOpacity style={styles.button} onPress={toggleLanguage}>
      <Text style={styles.text}>{language === 'de' ? 'EN' : 'DE'}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  text: { color: '#fff', fontSize: 13, fontWeight: '700' },
});
