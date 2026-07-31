import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import VenueMapNative from '../components/VenueMapNative';
import BottomTabBar from '../components/BottomTabBar';

export default function SpaetisMapScreen() {
  const params = useLocalSearchParams<{ id?: string; lat?: string; lng?: string }>();
  return (
    <View style={{ flex: 1 }}>
      <VenueMapNative
        type="spaeti"
        targetId={params.id ?? null}
        targetLat={params.lat ? parseFloat(params.lat) : null}
        targetLng={params.lng ? parseFloat(params.lng) : null}
      />
      <BottomTabBar active="spaetis" mapRoute="/spaetis-map" />
    </View>
  );
}
