// Eigene, schlanke Leaflet-Karte für Bars statt Wiederverwendung von
// LeafletMapView.web.tsx (die ist auf Event-Popups mit Terminliste
// zugeschnitten) — gleiche Grundstruktur (MapContainer/TileLayer/Marker/
// Popup), aber eigener Popup-Inhalt (Öffnungsstatus, heutige Öffnungszeiten,
// Website). In eigener Datei aus demselben Grund wie LeafletMapView.web.tsx:
// Leaflet greift beim Import auf window/document zu, per dynamischem
// import() nur im Browser geladen (siehe BarsMapNative.web.tsx).
//
// Bar-Marker als farbige CircleMarker statt Leaflets Standard-Pin: der
// Standard-Pin ist blau, exakt dieselbe Akzentfarbe (#0af) wie der "das bin
// ich"-Punkt — beides blau ließ sich auf der Karte kaum unterscheiden. Grün/
// Rot/Grau kodiert zusätzlich den Öffnungsstatus direkt auf der Karte, statt
// ihn nur im Popup zu verraten.
import { useEffect, useRef } from 'react';
import { StyleSheet, View, Text, Pressable } from 'react-native';
import type L from 'leaflet';
import { MapContainer, TileLayer, Popup, Circle, CircleMarker, useMap } from 'react-leaflet';
import { todayLabel } from '../lib/openingHours';

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

// Nur der Bar-Name reicht bei generischen OSM-Namen nicht als Suchbegriff —
// z.B. ist eine Bar in OSM schlicht als "Bridge" statt "Bridge Bar" gepflegt,
// eine reine Namenssuche auf Google Maps interpretiert das dann als
// Freitextsuche und findet echte Brücken statt der Bar. Mit Adresse ist die
// Anfrage eindeutig; ganz ohne Adresse lieber auf die exakten Koordinaten
// zurückfallen statt auf den (ggf. mehrdeutigen) nackten Namen.
function googleMapsUrl(lat: number, lng: number, name: string, address?: string | null) {
  const query = address ? `${name}, ${address}` : null;
  return query
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`
    : `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

function markerColor(open: boolean | null): string {
  return open === true ? '#4ade80' : open === false ? '#ff6b6b' : '#999';
}

// Öffnet beim Laden automatisch das Popup einer bestimmten Bar, wenn von der
// Listenansicht per id-Param dorthin navigiert wurde (Pendant zu
// AutoOpenPopup in LeafletMapView.web.tsx für die Event-Karte).
function AutoOpenPopup({ targetId, markerRefs }: { targetId: string | null; markerRefs: React.MutableRefObject<Map<string, L.CircleMarker>> }) {
  const map = useMap();
  useEffect(() => {
    if (!targetId) return;
    const timeout = setTimeout(() => {
      markerRefs.current.get(targetId)?.openPopup();
    }, 400);
    return () => clearTimeout(timeout);
  }, [targetId, map, markerRefs]);
  return null;
}

export default function BarsLeafletView({
  bars,
  centerLat,
  centerLng,
  zoom,
  userLocation,
  targetId = null,
}: {
  bars: BarMarker[];
  centerLat: number;
  centerLng: number;
  zoom: number;
  userLocation?: { lat: number; lng: number } | null;
  targetId?: string | null;
}) {
  const markerRefs = useRef<Map<string, L.CircleMarker>>(new Map());

  return (
    <MapContainer center={[centerLat, centerLng]} zoom={zoom} style={styles.map}>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {bars.map((bar) => {
        const hoursToday = todayLabel(bar.opening_hours_raw);
        const color = markerColor(bar.open);
        return (
          <CircleMarker
            key={bar.id}
            center={[bar.latitude, bar.longitude]}
            radius={9}
            pathOptions={{ color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 }}
            ref={(ref) => {
              if (ref) markerRefs.current.set(bar.id, ref);
            }}
          >
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
                <Pressable onPress={() => window.open(googleMapsUrl(bar.latitude, bar.longitude, bar.name, bar.address), '_blank')}>
                  <Text style={styles.popupMapsButton}>In Google Maps öffnen</Text>
                </Pressable>
              </View>
            </Popup>
          </CircleMarker>
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
      <AutoOpenPopup targetId={targetId} markerRefs={markerRefs} />
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
