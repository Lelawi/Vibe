import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import VenueMapNative from '../components/VenueMapNative';
import BottomTabBar from '../components/BottomTabBar';

export default function BarsMapScreen() {
  const params = useLocalSearchParams<{ id?: string; lat?: string; lng?: string }>();
  return (
    <View style={{ flex: 1 }}>
      <VenueMapNative
        type="bar"
        targetId={params.id ?? null}
        targetLat={params.lat ? parseFloat(params.lat) : null}
        targetLng={params.lng ? parseFloat(params.lng) : null}
      />
      <BottomTabBar active="bars" mapRoute="/bars-map" />
    </View>
  );
}
