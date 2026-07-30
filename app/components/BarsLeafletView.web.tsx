// Eigene, schlanke Leaflet-Karte für Bars statt Wiederverwendung von
// LeafletMapView.web.tsx (die ist auf Event-Popups mit Terminliste
// zugeschnitten) — gleiche Grundstruktur (MapContainer/TileLayer/Marker/
// Popup), aber eigener Popup-Inhalt (Öffnungsstatus, heutige Öffnungszeiten,
// Website). In eigener Datei aus demselben Grund wie LeafletMapView.web.tsx:
// Leaflet greift beim Import auf window/document zu, per dynamischem
// import() nur im Browser geladen (siehe BarsMapNative.web.tsx).
import { StyleSheet, View, Text, Pressable } from 'react-native';
import L from 'leaflet';
import { MapContainer, TileLayer, Marker, Popup, Circle, CircleMarker } from 'react-leaflet';
import { todayLabel } from '../lib/openingHours';

delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

export type BarMarker = {
  id: string;
  name: string;
  address: string | null;
  latitude: number;
  longitude: number;
  opening_hours_raw: string | null;
  open: boolean | null;
  website: string | null;
};

function googleMapsUrl(lat: number, lng: number, label?: string) {
  const query = label?.trim();
  return query
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`
    : `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

export default function BarsLeafletView({
  bars,
  centerLat,
  centerLng,
  zoom,
  userLocation,
}: {
  bars: BarMarker[];
  centerLat: number;
  centerLng: number;
  zoom: number;
  userLocation?: { lat: number; lng: number } | null;
}) {
  return (
    <MapContainer center={[centerLat, centerLng]} zoom={zoom} style={styles.map}>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {bars.map((bar) => {
        const hoursToday = todayLabel(bar.opening_hours_raw);
        return (
          <Marker key={bar.id} position={[bar.latitude, bar.longitude]}>
            <Popup minWidth={200}>
              <View style={styles.popup}>
                <View style={styles.popupHeaderRow}>
                  <Text style={styles.popupTitle}>{bar.name}</Text>
                  {bar.open === true && <Text style={styles.openBadge}>Geöffnet</Text>}
                  {bar.open === false && <Text style={styles.closedBadge}>Geschlossen</Text>}
                </View>
                {bar.address && <Text style={styles.popupAddress}>{bar.address}</Text>}
                {hoursToday && <Text style={styles.popupHours}>Heute: {hoursToday}</Text>}
                {bar.website && (
                  <Pressable onPress={() => window.open(bar.website!, '_blank')}>
                    <Text style={styles.popupLink}>Website öffnen</Text>
                  </Pressable>
                )}
                <Pressable onPress={() => window.open(googleMapsUrl(bar.latitude, bar.longitude, bar.name), '_blank')}>
                  <Text style={styles.popupMapsButton}>In Google Maps öffnen</Text>
                </Pressable>
              </View>
            </Popup>
          </Marker>
        );
      })}
      {userLocation && (
        <>
          <Circle
            center={[userLocation.lat, userLocation.lng]}
            radius={80}
            pathOptions={{ color: '#0af', fillColor: '#0af', fillOpacity: 0.15, weight: 0 }}
          />
          <CircleMarker
            center={[userLocation.lat, userLocation.lng]}
            radius={7}
            pathOptions={{ color: '#fff', weight: 2, fillColor: '#0af', fillOpacity: 1 }}
          />
        </>
      )}
    </MapContainer>
  );
}

const styles = StyleSheet.create({
  map: { flex: 1, width: '100%', height: '100%' },
  popup: { minWidth: 200, padding: 4 },
  popupHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  popupTitle: { fontWeight: '700', fontSize: 14, color: '#000' },
  openBadge: { fontSize: 10, fontWeight: '700', color: '#1a7a3d', backgroundColor: '#4ade8033', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  closedBadge: { fontSize: 10, fontWeight: '700', color: '#b3261e', backgroundColor: '#ff6b6b33', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  popupAddress: { fontSize: 12, color: '#444' },
  popupHours: { fontSize: 12, color: '#444', marginTop: 2 },
  popupLink: { fontSize: 12, color: '#0af', fontWeight: '600', marginTop: 6 },
  popupMapsButton: { fontSize: 12, color: '#0af', fontWeight: '600', marginTop: 4 },
});
