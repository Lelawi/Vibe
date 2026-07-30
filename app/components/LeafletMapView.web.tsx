// Enthält die eigentliche Leaflet-Karte. In einer eigenen Datei, damit sie nur
// per dynamischem import() geladen wird (siehe MapNative.web.tsx) — Leaflet
// greift beim Modul-Import direkt auf `window`/`document` zu und würde einen
// serverseitigen Prerender-Schritt (Expo Web-Export mit output: "static")
// zum Absturz bringen, wenn es auf oberster Ebene importiert würde.
import { useEffect, useRef } from 'react';
import { StyleSheet, View, Text, Pressable, ScrollView } from 'react-native';
import L from 'leaflet';
import { MapContainer, TileLayer, Marker, Popup, Circle, CircleMarker, useMap } from 'react-leaflet';
import MarkerClusterGroup from 'react-leaflet-cluster';
import { createClusterIcon } from '../lib/leafletCluster';

// Leaflets Standard-Marker-Icons verweisen auf relative Bildpfade, die unter
// Metro/Webpack-Bundlern nicht auflösen — stattdessen auf die CDN-Bilder
// verweisen (gleiche Quelle wie das in +html.tsx eingebundene Leaflet-CSS).
delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

export type VenueEvent = {
  id: string;
  title: string;
  start_date: string;
  start_time: string | null;
};

export type VenueMarker = {
  key: string;
  names: string[];
  latitude: number;
  longitude: number;
  events: VenueEvent[];
};

const MAX_POPUP_EVENTS = 5;

function venueTitle(names: string[]) {
  if (names.length === 1) return names[0];
  if (names.length <= 3) return names.join(' / ');
  return `${names[0]} + ${names.length - 1} weitere`;
}

function formatShort(dateStr: string, timeStr: string | null) {
  const date = new Date(`${dateStr}T${timeStr ?? '00:00'}`);
  const formatted = date.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: 'short' });
  return timeStr ? `${formatted} · ${timeStr.slice(0, 5)}` : formatted;
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
  userLocation,
  onOpenEvent,
  onOpenList,
}: {
  venues: VenueMarker[];
  centerLat: number;
  centerLng: number;
  zoom: number;
  targetKey: string | null;
  userLocation?: { lat: number; lng: number } | null;
  onOpenEvent: (id: string) => void;
  onOpenList: (names: string[]) => void;
}) {
  const markerRefs = useRef<Map<string, L.Marker>>(new Map());

  return (
    <MapContainer
      center={[centerLat, centerLng]}
      zoom={zoom}
      style={styles.map}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <MarkerClusterGroup
        iconCreateFunction={createClusterIcon}
        showCoverageOnHover={false}
        maxClusterRadius={60}
      >
        {venues.map((v) => {
          const shownEvents = v.events.slice(0, MAX_POPUP_EVENTS);
          const remaining = v.events.length - shownEvents.length;
          return (
            <Marker
              key={v.key}
              position={[v.latitude, v.longitude]}
              ref={(ref) => {
                if (ref) markerRefs.current.set(v.key, ref);
              }}
            >
              <Popup minWidth={220}>
                <View style={styles.popup}>
                  <Text style={styles.popupTitle}>{venueTitle(v.names)}</Text>
                  <ScrollView style={styles.popupEventList}>
                    {shownEvents.map((ev) => (
                      <Pressable key={ev.id} style={styles.popupEventRow} onPress={() => onOpenEvent(ev.id)}>
                        <Text style={styles.popupEventTitle} numberOfLines={1}>{ev.title}</Text>
                        <Text style={styles.popupEventDate}>{formatShort(ev.start_date, ev.start_time)}</Text>
                      </Pressable>
                    ))}
                  </ScrollView>
                  {remaining > 0 && (
                    <Pressable onPress={() => onOpenList(v.names)}>
                      <Text style={styles.popupMoreLink}>+ {remaining} weitere · Liste öffnen</Text>
                    </Pressable>
                  )}
                  <Pressable
                    style={styles.popupMapsButton}
                    onPress={() => window.open(googleMapsUrl(v.latitude, v.longitude, venueTitle(v.names)), '_blank')}
                  >
                    <Text style={styles.popupMapsButtonText}>In Google Maps öffnen</Text>
                  </Pressable>
                </View>
              </Popup>
            </Marker>
          );
        })}
      </MarkerClusterGroup>
      {userLocation && (
        <>
          {/* interactive={false}: ohne das fängt dieser Halo-Kreis Klicks ab,
              die eigentlich einem darunterliegenden Marker galten — Events
              nah an der eigenen Position ließen sich dadurch nicht öffnen
              (identischer Bug wie bei der Bars/Restaurants-Karte). */}
          <Circle
            center={[userLocation.lat, userLocation.lng]}
            radius={80}
            interactive={false}
            pathOptions={{ color: '#0af', fillColor: '#0af', fillOpacity: 0.15, weight: 0 }}
          />
          <CircleMarker
            center={[userLocation.lat, userLocation.lng]}
            radius={7}
            interactive={false}
            pathOptions={{ color: '#fff', weight: 2, fillColor: '#0af', fillOpacity: 1 }}
          />
        </>
      )}
      <AutoOpenPopup targetKey={targetKey} markerRefs={markerRefs} />
    </MapContainer>
  );
}

const styles = StyleSheet.create({
  map: { flex: 1, width: '100%', height: '100%' },
  popup: { minWidth: 220, padding: 4 },
  popupTitle: { fontWeight: '700', fontSize: 14, marginBottom: 6, color: '#000' },
  popupEventList: { maxHeight: 180 },
  popupEventRow: {
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  popupEventTitle: { fontSize: 13, fontWeight: '600', color: '#111' },
  popupEventDate: { fontSize: 11, color: '#666', marginTop: 1 },
  popupMoreLink: { fontSize: 12, color: '#0af', fontWeight: '600', marginTop: 6 },
  popupMapsButton: {
    backgroundColor: '#0af',
    borderRadius: 8,
    paddingVertical: 6,
    alignItems: 'center',
    marginTop: 8,
  },
  popupMapsButtonText: { color: '#000', fontWeight: '700', fontSize: 12 },
});
