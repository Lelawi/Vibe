import { useLocalSearchParams } from 'expo-router';
import VenueMapNative from '../components/VenueMapNative';

export default function RestaurantsMapScreen() {
  const params = useLocalSearchParams<{ id?: string; lat?: string; lng?: string }>();
  return (
    <VenueMapNative
      type="restaurant"
      targetId={params.id ?? null}
      targetLat={params.lat ? parseFloat(params.lat) : null}
      targetLng={params.lng ? parseFloat(params.lng) : null}
    />
  );
}
