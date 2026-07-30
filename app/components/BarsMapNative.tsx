import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View, ActivityIndicator, Text, Linking, Pressable } from 'react-native';
import MapView, { Marker, Callout } from 'react-native-maps';
import { supabase } from '../lib/supabase';
import { isOpenNow, todayLabel } from '../lib/openingHours';

type Bar = {
  id: string;
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  opening_hours_raw: string | null;
  website: string | null;
};

function openInGoogleMaps(lat: number, lng: number, label?: string) {
  const query = label?.trim();
  const url = query
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`
    : `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  Linking.openURL(url);
}

export default function BarsMapNative() {
  const [bars, setBars] = useState<Bar[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadBars() {
      const { data, error } = await supabase
        .from('bars')
        .select('id,name,address,latitude,longitude,opening_hours_raw,website')
        .not('latitude', 'is', null)
        .not('longitude', 'is', null);
      if (!error) setBars((data ?? []) as Bar[]);
      setLoading(false);
    }
    loadBars();
  }, []);

  const markers = useMemo(
    () => bars.map((b) => ({ ...b, open: isOpenNow(b.opening_hours_raw), hoursToday: todayLabel(b.opening_hours_raw) })),
    [bars]
  );

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#fff" />
      </View>
    );
  }

  return (
    <MapView
      style={styles.map}
      initialRegion={{ latitude: 48.1371, longitude: 11.5754, latitudeDelta: 0.08, longitudeDelta: 0.08 }}
      showsUserLocation
      showsMyLocationButton
    >
      {markers.map((bar) => (
        <Marker key={bar.id} coordinate={{ latitude: bar.latitude!, longitude: bar.longitude! }}>
          <Callout tooltip={false}>
            <View style={styles.callout}>
              <View style={styles.calloutHeaderRow}>
                <Text style={styles.calloutTitle}>{bar.name}</Text>
                {bar.open === true && <Text style={styles.openBadge}>Geöffnet</Text>}
                {bar.open === false && <Text style={styles.closedBadge}>Geschlossen</Text>}
              </View>
              {bar.address && <Text style={styles.calloutAddress}>{bar.address}</Text>}
              {bar.hoursToday && <Text style={styles.calloutHours}>Heute: {bar.hoursToday}</Text>}
              {bar.website && (
                <Pressable onPress={() => Linking.openURL(bar.website!)}>
                  <Text style={styles.calloutLink}>Website öffnen</Text>
                </Pressable>
              )}
              <Pressable onPress={() => openInGoogleMaps(bar.latitude!, bar.longitude!, bar.name)}>
                <Text style={styles.calloutLink}>In Google Maps öffnen</Text>
              </Pressable>
            </View>
          </Callout>
        </Marker>
      ))}
    </MapView>
  );
}

const styles = StyleSheet.create({
  map: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' },
  callout: { minWidth: 200, padding: 4 },
  calloutHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  calloutTitle: { fontWeight: '700', fontSize: 14 },
  openBadge: { fontSize: 10, fontWeight: '700', color: '#1a7a3d', backgroundColor: '#4ade8033', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  closedBadge: { fontSize: 10, fontWeight: '700', color: '#b3261e', backgroundColor: '#ff6b6b33', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  calloutAddress: { fontSize: 12, color: '#444' },
  calloutHours: { fontSize: 12, color: '#444', marginTop: 2 },
  calloutLink: { fontSize: 12, color: '#0af', fontWeight: '600', marginTop: 4 },
});
