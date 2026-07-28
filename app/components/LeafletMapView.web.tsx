// Enthält die eigentliche Leaflet-Karte. In einer eigenen Datei, damit sie nur
// per dynamischem import() geladen wird (siehe MapNative.web.tsx) — Leaflet
// greift beim Modul-Import direkt auf `window`/`document` zu und würde einen
// serverseitigen Prerender-Schritt (Expo Web-Export mit output: "static")
// zum Absturz bringen, wenn es auf oberster Ebene importiert würde.
import { useEffect, useRef } from 'react';
import { StyleSheet, View, Text, Pressable } from 'react-native';
import L from 'leaflet';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';

// Leaflets Standard-Marker-Icons verweisen auf relative Bildpfade, die unter
// Metro/Webpack-Bundlern nicht auflösen — stattdessen auf die CDN-Bilder
// verweisen (gleiche Quelle wie das in +html.tsx eingebundene Leaflet-CSS).
delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

export type VenueMarker = {
  key: string;
  names: string[];
  latitude: number;
  longitude: number;
  count: number;
};

function venueTitle(names: string[]) {
  if (names.length === 1) return names[0];
  if (names.length <= 3) return names.join(' / ');
  return `${names[0]} + ${names.length - 1} weitere`;
}

function googleMapsUrl(lat: number, lng: number, label?: string) {
  const query = label?.trim();
  return query
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`
    : `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

// Öffnet beim Laden automatisch das Popup eines Markers, wenn von der
// Kartenansicht per lat/lng-Param dorthin navigiert wurde (Pendant zu
// markerRefs.current.get(key)?.showCallout() in der nativen Karte).
function AutoOpenPopup({ targetKey, markerRefs }: { targetKey: string | null; markerRefs: React.MutableRefObject<Map<string, L.Marker>> }) {
  const map = useMap();
  useEffect(() => {
    if (!targetKey) return;
    const timeout = setTimeout(() => {
      markerRefs.current.get(targetKey)?.openPopup();
    }, 400);
    return () => clearTimeout(timeout);
  }, [targetKey, map, markerRefs]);
  return null;
}

export default function LeafletMapView({
  venues,
  centerLat,
  centerLng,
  zoom,
  targetKey,
  onOpenList,
}: {
  venues: VenueMarker[];
  centerLat: number;
  centerLng: number;
  zoom: number;
  targetKey: string | null;
  onOpenList: (names: string[]) => void;
}) {
  const markerRefs = useRef<Map<string, L.Marker>>(new Map());

  return (
    <MapContainer
      center={[centerLat, centerLng]}
      zoom={zoom}
      style={styles.map}
      // @ts-expect-error react-leaflet types don't include children prop signature here
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {venues.map((v) => (
        <Marker
          key={v.key}
          position={[v.latitude, v.longitude]}
          ref={(ref) => {
            if (ref) markerRefs.current.set(v.key, ref);
          }}
        >
          <Popup>
            <View style={styles.popup}>
              <Pressable onPress={() => onOpenList(v.names)}>
                <Text style={styles.popupTitle}>{venueTitle(v.names)}</Text>
                <Text style={styles.popupSubtitle}>
                  {v.count} Event{v.count === 1 ? '' : 's'} · Liste öffnen
                </Text>
              </Pressable>
              <Pressable
                style={styles.popupMapsButton}
                onPress={() => window.open(googleMapsUrl(v.latitude, v.longitude, venueTitle(v.names)), '_blank')}
              >
                <Text style={styles.popupMapsButtonText}>In Google Maps öffnen</Text>
              </Pressable>
            </View>
          </Popup>
        </Marker>
      ))}
      <AutoOpenPopup targetKey={targetKey} markerRefs={markerRefs} />
    </MapContainer>
  );
}

const styles = StyleSheet.create({
  map: { flex: 1, width: '100%', height: '100%' },
  popup: { minWidth: 180, padding: 4 },
  popupTitle: { fontWeight: '700', fontSize: 14, marginBottom: 2, color: '#000' },
  popupSubtitle: { fontSize: 12, color: '#666', marginBottom: 8 },
  popupMapsButton: {
    backgroundColor: '#0af',
    borderRadius: 8,
    paddingVertical: 6,
    alignItems: 'center',
  },
  popupMapsButtonText: { color: '#000', fontWeight: '700', fontSize: 12 },
});
