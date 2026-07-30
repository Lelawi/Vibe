import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';

// Gemeinsamer Umschalter zwischen der Events- und der Bars-Ansicht. Ersetzt
// den bisherigen kleinen "Bars"-Button neben "Karte" auf der Startseite
// (leicht übersehen, wirkte wie ein Nebenfeature) und die separate
// "‹ Übersicht"-Zurück-Zeile auf dem Bars-Screen — beide Ansichten sind
// gleichrangig, der Wechsel soll sich auch so anfühlen.
export default function ViewSwitcher({ active }: { active: 'events' | 'bars' }) {
  const router = useRouter();
  return (
    <View style={styles.wrap}>
      <TouchableOpacity
        style={[styles.segment, active === 'events' && styles.segmentActive]}
        onPress={() => active !== 'events' && router.replace('/')}
      >
        <Text style={[styles.label, active === 'events' && styles.labelActive]}>Events</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.segment, active === 'bars' && styles.segmentActive]}
        onPress={() => active !== 'bars' && router.replace('/bars')}
      >
        <Text style={[styles.label, active === 'bars' && styles.labelActive]}>Bars</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 20,
    padding: 3,
    gap: 2,
  },
  segment: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 17 },
  segmentActive: { backgroundColor: '#0af' },
  label: { color: '#999', fontSize: 13, fontWeight: '600' },
  labelActive: { color: '#000' },
});
