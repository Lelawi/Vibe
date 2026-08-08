import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { registerStrings, useTranslation } from '../lib/strings';

export type BottomTab = 'events' | 'bars' | 'restaurants' | 'spaetis';

registerStrings({
  'tabs.events': { de: 'Events', en: 'Events' },
  'tabs.bars': { de: 'Bars', en: 'Bars' },
  'tabs.restaurants': { de: 'Restaurants', en: 'Restaurants' },
  'tabs.spaetis': { de: 'Spätis', en: 'Kiosks' },
  'tabs.map': { de: 'Karte', en: 'Map' },
});

// Ersetzt den bisherigen ViewSwitcher-Pill oben im Banner: jede professionelle
// Vergleichs-App (Instagram, Yelp, DICE) navigiert über eine untere Tab-Leiste
// statt eines Buttons oben rechts, weil das mit dem Daumen erreichbar ist,
// ohne die Hand am Screen zu verschieben — bei größeren Handys war der obere
// Pill nur mit beiden Händen bequem erreichbar. "Karte" ist bewusst KEIN
// eigener Tab hier mehr (siehe Git-Historie) — sie war als 5. Item optisch
// gleichrangig mit den vier Inhaltskategorien, obwohl sie inhaltlich nur eine
// alternative Ansicht der jeweils aktiven Kategorie ist. Der Kartenzugriff
// sitzt jetzt als Icon-Button neben der Suche auf jedem Listen-Screen (siehe
// index.tsx/VenueListScreen.tsx), kontextabhängig wie zuvor über die
// jeweilige mapRoute der Kategorie.
const TABS: { key: BottomTab; labelKey: string; icon: keyof typeof Ionicons.glyphMap; activeIcon: keyof typeof Ionicons.glyphMap; route: string }[] = [
  { key: 'events', labelKey: 'tabs.events', icon: 'calendar-outline', activeIcon: 'calendar', route: '/' },
  { key: 'bars', labelKey: 'tabs.bars', icon: 'beer-outline', activeIcon: 'beer', route: '/bars' },
  { key: 'restaurants', labelKey: 'tabs.restaurants', icon: 'restaurant-outline', activeIcon: 'restaurant', route: '/restaurants' },
  { key: 'spaetis', labelKey: 'tabs.spaetis', icon: 'storefront-outline', activeIcon: 'storefront', route: '/spaetis' },
];

interface BottomTabBarProps {
  active: BottomTab;
  // Optionaler Inhalt direkt über den Tabs, innerhalb derselben fixen,
  // position:absolute-Fläche (z.B. die Suchleiste im Events-Screen, siehe
  // index.tsx). Bewusst ein Slot dieser Komponente statt eines zweiten,
  // eigenständig positionierten Elements in index.tsx — sonst müsste dessen
  // "bottom"-Offset die Safe-Area-/Tab-Höhen-Berechnung hier duplizieren und
  // bei jeder Änderung synchron gehalten werden.
  topSlot?: React.ReactNode;
}

export default function BottomTabBar({ active, topSlot }: BottomTabBarProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.wrap, { paddingBottom: Math.max(insets.bottom, 8) }]}>
      {topSlot}
      <View style={styles.tabsRow}>
      {TABS.map((tab) => {
        const isActive = tab.key === active;
        return (
          <TouchableOpacity
            key={tab.key}
            style={styles.tab}
            // onPressIn (feuert beim Touch-Start) statt onPress (feuert erst
            // beim Touch-Ende) — war die Suchleiste gerade fokussiert, verlor
            // sie den Fokus beim ersten Antippen der Tab-Leiste, was auf
            // mobilen Browsern (v.a. iOS Safari) das eigentliche onPress-
            // Ereignis des angetippten Buttons oft schluckt. Der erste Tap
            // schloss dann nur die Tastatur, ohne den Reiter zu wechseln,
            // ein zweiter Tap landete durch das Reflow beim Tastatur-
            // Einklappen daneben (per Nutzer-Feedback: landete auf "Events").
            // onPressIn feuert im selben Moment wie der Fokusverlust, bevor
            // das Reflow etwas verschiebt.
            onPressIn={() => !isActive && router.replace(tab.route)}
          >
            <Ionicons name={isActive ? tab.activeIcon : tab.icon} size={22} color={isActive ? '#0af' : '#888'} />
            <Text style={[styles.label, isActive && styles.labelActive]}>{t(tab.labelKey)}</Text>
          </TouchableOpacity>
        );
      })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(10,10,10,0.96)',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.08)',
  },
  tabsRow: { flexDirection: 'row', paddingTop: 8 },
  tab: { flex: 1, alignItems: 'center', gap: 2 },
  label: { fontSize: 11, fontWeight: '600', color: '#888' },
  labelActive: { color: '#0af' },
});
