import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export type BottomTab = 'events' | 'bars' | 'restaurants';

// Ersetzt den bisherigen ViewSwitcher-Pill oben im Banner: jede professionelle
// Vergleichs-App (Instagram, Yelp, DICE) navigiert über eine untere Tab-Leiste
// statt eines Buttons oben rechts, weil das mit dem Daumen erreichbar ist,
// ohne die Hand am Screen zu verschieben — bei größeren Handys war der obere
// Pill nur mit beiden Händen bequem erreichbar. "Karte" ist bewusst
// kontextabhängig: von welchem Tab aus man sie öffnet, bestimmt, welche Karte
// (Events/Bars/Restaurants) aufgeht, statt eine feste Route zu sein.
const TABS: { key: BottomTab; label: string; icon: keyof typeof Ionicons.glyphMap; activeIcon: keyof typeof Ionicons.glyphMap; route: string }[] = [
  { key: 'events', label: 'Events', icon: 'calendar-outline', activeIcon: 'calendar', route: '/' },
  { key: 'bars', label: 'Bars', icon: 'beer-outline', activeIcon: 'beer', route: '/bars' },
  { key: 'restaurants', label: 'Restaurants', icon: 'restaurant-outline', activeIcon: 'restaurant', route: '/restaurants' },
];

export default function BottomTabBar({ active, mapRoute }: { active: BottomTab; mapRoute: string }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.wrap, { paddingBottom: Math.max(insets.bottom, 8) }]}>
      {TABS.map((tab) => {
        const isActive = tab.key === active;
        return (
          <TouchableOpacity
            key={tab.key}
            style={styles.tab}
            onPress={() => !isActive && router.replace(tab.route)}
          >
            <Ionicons name={isActive ? tab.activeIcon : tab.icon} size={22} color={isActive ? '#0af' : '#888'} />
            <Text style={[styles.label, isActive && styles.labelActive]}>{tab.label}</Text>
          </TouchableOpacity>
        );
      })}
      <TouchableOpacity style={styles.tab} onPress={() => router.push(mapRoute)}>
        <Ionicons name="map-outline" size={22} color="#888" />
        <Text style={styles.label}>Karte</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    backgroundColor: 'rgba(10,10,10,0.96)',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.08)',
    paddingTop: 8,
  },
  tab: { flex: 1, alignItems: 'center', gap: 2 },
  label: { fontSize: 11, fontWeight: '600', color: '#888' },
  labelActive: { color: '#0af' },
});
