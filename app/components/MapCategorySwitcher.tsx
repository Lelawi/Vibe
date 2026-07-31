import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { registerStrings, useTranslation } from '../lib/strings';

export type MapCategory = 'events' | 'bars' | 'restaurants' | 'spaetis';

// Dieselben Werte wie in BottomTabBar.tsx unter demselben "tabs.*"-
// Namespace registriert — hier zusätzlich noch einmal registriert (Object.
// assign ist idempotent), damit diese Komponente nicht von der Lade-
// Reihenfolge der Module abhängt, falls sie mal unabhängig von BottomTabBar
// gerendert wird.
registerStrings({
  'tabs.events': { de: 'Events', en: 'Events' },
  'tabs.bars': { de: 'Bars', en: 'Bars' },
  'tabs.restaurants': { de: 'Restaurants', en: 'Restaurants' },
  'tabs.spaetis': { de: 'Spätis', en: 'Kiosks' },
});

// Direktes Umschalten zwischen den drei Karten, ohne vorher zurück auf eine
// Listenansicht wechseln zu müssen (Nutzer-Feedback: der bisherige Weg über
// BottomTabBar war "Kategorie-Tab antippen -> Liste -> Karte-Button
// antippen", zwei Schritte zu viel). router.replace statt push: die alte
// Karte soll nicht auf dem Stack bleiben, sonst häuft sich bei mehrfachem
// Hin-und-Herschalten unnötig Navigationshistorie an. Ziel-Koordinaten
// (falls von einem Karteneintrag angewählt) werden dabei bewusst NICHT
// mitgenommen — ein Ziel in einer anderen Kategorie ergibt keinen Sinn.
// labelKey verweist auf dieselben Strings wie BottomTabBar.tsx (registriert
// dort unter demselben "tabs.*"-Namespace) — identische Bezeichnungen,
// keine eigene Übersetzung nötig.
const CATEGORIES: { key: MapCategory; labelKey: string; route: string }[] = [
  { key: 'events', labelKey: 'tabs.events', route: '/map' },
  { key: 'bars', labelKey: 'tabs.bars', route: '/bars-map' },
  { key: 'restaurants', labelKey: 'tabs.restaurants', route: '/restaurants-map' },
  { key: 'spaetis', labelKey: 'tabs.spaetis', route: '/spaetis-map' },
];

export default function MapCategorySwitcher({ active }: { active: MapCategory }) {
  const { t } = useTranslation();
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
            <Text style={[styles.segmentText, isActive && styles.segmentTextActive]}>{t(cat.labelKey)}</Text>
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
