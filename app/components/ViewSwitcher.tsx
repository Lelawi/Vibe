import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';

// Gemeinsamer Umschalter zwischen der Events- und der Bars-Ansicht. Ersetzt
// den bisherigen kleinen "Bars"-Button neben "Karte" auf der Startseite
// (leicht übersehen, wirkte wie ein Nebenfeature) und die separate
// "‹ Übersicht"-Zurück-Zeile auf dem Bars-Screen — beide Ansichten sind
// gleichrangig, der Wechsel soll sich auch so anfühlen.
const SEGMENTS: { key: 'events' | 'bars' | 'restaurants'; label: string; route: string }[] = [
  { key: 'events', label: 'Events', route: '/' },
  { key: 'bars', label: 'Bars', route: '/bars' },
  { key: 'restaurants', label: 'Restaurants', route: '/restaurants' },
];

export default function ViewSwitcher({ active }: { active: 'events' | 'bars' | 'restaurants' }) {
  const router = useRouter();
  return (
    <View style={styles.wrap}>
      {SEGMENTS.map((s) => (
        <TouchableOpacity
          key={s.key}
          style={[styles.segment, active === s.key && styles.segmentActive]}
          onPress={() => active !== s.key && router.replace(s.route)}
        >
          <Text style={[styles.label, active === s.key && styles.labelActive]}>{s.label}</Text>
        </TouchableOpacity>
      ))}
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
