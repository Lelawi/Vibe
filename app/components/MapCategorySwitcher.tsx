import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';

export type MapCategory = 'events' | 'bars' | 'restaurants';

// Direktes Umschalten zwischen den drei Karten, ohne vorher zurück auf eine
// Listenansicht wechseln zu müssen (Nutzer-Feedback: der bisherige Weg über
// BottomTabBar war "Kategorie-Tab antippen -> Liste -> Karte-Button
// antippen", zwei Schritte zu viel). router.replace statt push: die alte
// Karte soll nicht auf dem Stack bleiben, sonst häuft sich bei mehrfachem
// Hin-und-Herschalten unnötig Navigationshistorie an. Ziel-Koordinaten
// (falls von einem Karteneintrag angewählt) werden dabei bewusst NICHT
// mitgenommen — ein Ziel in einer anderen Kategorie ergibt keinen Sinn.
const CATEGORIES: { key: MapCategory; label: string; route: string }[] = [
  { key: 'events', label: 'Events', route: '/map' },
  { key: 'bars', label: 'Bars', route: '/bars-map' },
  { key: 'restaurants', label: 'Restaurants', route: '/restaurants-map' },
];

export default function MapCategorySwitcher({ active }: { active: MapCategory }) {
  const router = useRouter();

  return (
    <View style={styles.wrap}>
      {CATEGORIES.map((cat) => {
        const isActive = cat.key === active;
        return (
          <TouchableOpacity
            key={cat.key}
            style={[styles.segment, isActive && styles.segmentActive]}
            onPress={() => !isActive && router.replace(cat.route)}
          >
            <Text style={[styles.segmentText, isActive && styles.segmentTextActive]}>{cat.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: 12,
    alignSelf: 'center',
    flexDirection: 'row',
    backgroundColor: 'rgba(20,20,20,0.92)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    borderRadius: 20,
    padding: 3,
    gap: 2,
    zIndex: 1000,
  },
  segment: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 17 },
  segmentActive: { backgroundColor: '#0af' },
  segmentText: { color: '#ccc', fontSize: 12, fontWeight: '600' },
  segmentTextActive: { color: '#000' },
});
