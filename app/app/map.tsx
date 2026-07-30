import { View } from 'react-native';
import MapNative from '../components/MapNative';
import BottomTabBar from '../components/BottomTabBar';

export default function MapScreen() {
  return (
    <View style={{ flex: 1 }}>
      <MapNative />
      <BottomTabBar active="events" mapRoute="/map" />
    </View>
  );
}
