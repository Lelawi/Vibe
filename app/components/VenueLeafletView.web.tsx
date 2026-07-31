// Eigene, schlanke Leaflet-Karte für Bars/Restaurants statt Wiederverwendung
// von LeafletMapView.web.tsx (die ist auf Event-Popups mit Terminliste
// zugeschnitten) — gleiche Grundstruktur (MapContainer/TileLayer/Marker/
// Popup), aber eigener Popup-Inhalt (Öffnungsstatus, heutige Öffnungszeiten,
// Website). In eigener Datei aus demselben Grund wie LeafletMapView.web.tsx:
// Leaflet greift beim Import auf window/document zu, per dynamischem
// import() nur im Browser geladen (siehe VenueMapNative.web.tsx).
//
// Marker als farbige divIcons statt Leaflets Standard-Pin: der Standard-Pin
// ist blau, exakt dieselbe Akzentfarbe (#0af) wie der "das bin ich"-Punkt —
// beides blau ließ sich auf der Karte kaum unterscheiden. Grün/Rot/Grau
// kodiert zusätzlich den Öffnungsstatus direkt auf der Karte, statt ihn nur
// im Popup zu verraten. Bewusst divIcon-Marker statt (vorher) CircleMarker:
// leaflet.markercluster gruppiert nur echte Icon-Marker, keine Vektor-Pfade
// (per Direktabruf der Bibliotheksdoku verifiziert, 2026-07) — bei 581 Bars
// bzw. 2263 Restaurants wären ungruppierte Marker beim Herauszoomen ein
// unlesbarer Fleckenteppich, und dicht beieinanderliegende Marker konnten
// sich gegenseitig am Anklicken hindern.
import { useEffect, useRef } from 'react';
import { StyleSheet, View, Text, Pressable, Image } from 'react-native';
import L from 'leaflet';
import { MapContainer, TileLayer, Marker, Popup, Circle, CircleMarker, useMap } from 'react-leaflet';
import MarkerClusterGroup from 'react-leaflet-cluster';
import { todayLabel } from '../lib/openingHours';
import { createClusterIcon, type VenueStatusMarker } from '../lib/leafletCluster';

export type VenueMarker = {
  id: string;
  name: string;
  address: string | null;
  latitude: number;
  longitude: number;
  opening_hours_raw: string | null;
  open: boolean | null;
  website: string | null;
  image_url: string | null;
};

// Nur der Name reicht bei generischen OSM-Namen nicht als Suchbegriff — z.B.
// ist eine Bar in OSM schlicht als "Bridge" statt "Bridge Bar" gepflegt, eine
// reine Namenssuche auf Google Maps interpretiert das dann als Freitextsuche
// und findet echte Brücken statt der Bar. Mit Adresse ist die Anfrage
// eindeutig; ganz ohne Adresse lieber auf die exakten Koordinaten
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

const iconCache = new Map<string, L.DivIcon>();

function createColoredIcon(color: string): L.DivIcon {
  const cached = iconCache.get(color);
  if (cached) return cached;
  const icon = L.divIcon({
    className: 'vibe-venue-marker',
    html: `<div style="width:18px;height:18px;border-radius:9px;background:${color};border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,0.4);"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
    popupAnchor: [0, -9],
  });
  iconCache.set(color, icon);
  return icon;
}

// Zoom-Stufe, auf die beim Anwählen eines konkreten Eintrags reingezoomt
// wird — tief genug, dass sich auch dicht beieinanderliegende Marker in der
// Münchner Innenstadt (viele Bars/Restaurants im selben Block) sicher
// auflösen, aber innerhalb dessen, was die OSM-Tiles noch scharf abbilden.
const FOCUS_ZOOM = 18;

// Öffnet beim Laden automatisch das Popup eines bestimmten Eintrags, wenn von
// der Listenansicht per id-Param dorthin navigiert wurde (Pendant zu
// FocusTarget in LeafletMapView.web.tsx für die Event-Karte).
//
// Zwei Bugs statt einem, beide mussten weg:
// 1) Ein einfaches marker.openPopup() reicht nicht: liegt der Ziel-Marker
//    gerade in einem Cluster, ist nur das Cluster-Icon auf der Karte, der
//    Marker selbst nicht — das Popup blieb lautlos zu.
// 2) Leaflet.markerclusters eigener "offizieller" Weg dafür, zoomToShowLayer,
//    hat selbst einen bekannten Bug: er wartet auf ein moveend/zoomend/
//    animationend-Event, feuert das aber NICHT, wenn die Zielansicht
//    (unser vorab per Listen-Klick gesetztes zoom=16) zufällig schon nah
//    genug am gewünschten Zustand war — genau der beobachtete Fall "klappt
//    nur, wenn kein anderes Venue in der Nähe ist" (siehe
//    node_modules/leaflet.markercluster/example/old-bugs/
//    zoomtoshowlayer-doesnt-need-to-zoom.html). Deshalb hier bewusst manuell
//    statt über zoomToShowLayer: map.setView(..., {animate:false}) wirkt
//    synchron (Leaflet berechnet die Cluster-Gruppierung dabei sofort neu,
//    kein Warten auf Events nötig), danach direkt prüfen ob der Marker jetzt
//    einzeln auf der Karte liegt und sonst seinen Cluster auffächern.
function FocusTarget({
  targetId,
  targetLat,
  targetLng,
  markerRefs,
}: {
  targetId: string | null;
  targetLat: number | null;
  targetLng: number | null;
  markerRefs: React.MutableRefObject<Map<string, L.Marker>>;
}) {
  const map = useMap();
  useEffect(() => {
    if (!targetId || targetLat == null || targetLng == null) return;
    let cancelled = false;
    let attempts = 0;
    function tryFocus() {
      if (cancelled) return;
      const marker = markerRefs.current.get(targetId!);
      if (!marker) {
        if (attempts++ < 20) setTimeout(tryFocus, 100);
        return;
      }
      map.setView([targetLat!, targetLng!], Math.max(map.getZoom(), FOCUS_ZOOM), { animate: false });
      if (map.hasLayer(marker)) {
        marker.openPopup();
        return;
      }
      // Noch immer geclustert (z.B. mehrere Venues mit (fast) identischen
      // Koordinaten, auch bei maximalem Zoom nicht auflösbar) — __parent ist
      // internes Leaflet.markercluster-API, nicht in den Typings, aber der
      // einzige Weg an den umschließenden Cluster zu kommen.
      const parent = (marker as unknown as { __parent?: L.MarkerCluster }).__parent;
      if (parent) {
        parent.spiderfy();
        setTimeout(() => marker.openPopup(), 50);
      }
    }
    tryFocus();
    return () => {
      cancelled = true;
    };
  }, [targetId, targetLat, targetLng, map, markerRefs]);
  return null;
}

export default function VenueLeafletView({
  venues,
  centerLat,
  centerLng,
  zoom,
  userLocation,
  targetId = null,
}: {
  venues: VenueMarker[];
  centerLat: number;
  centerLng: number;
  zoom: number;
  userLocation?: { lat: number; lng: number } | null;
  targetId?: string | null;
}) {
  const markerRefs = useRef<Map<string, L.Marker>>(new Map());

  return (
    <MapContainer center={[centerLat, centerLng]} zoom={zoom} style={styles.map}>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <MarkerClusterGroup
        iconCreateFunction={createClusterIcon}
        showCoverageOnHover={false}
        maxClusterRadius={60}
      >
        {venues.map((venue) => {
          const hoursToday = todayLabel(venue.opening_hours_raw);
          const color = markerColor(venue.open);
          return (
            <Marker
              key={venue.id}
              position={[venue.latitude, venue.longitude]}
              icon={createColoredIcon(color)}
              ref={(ref) => {
                if (ref) {
                  markerRefs.current.set(venue.id, ref);
                  // Für die Cluster-Einfärbung nach Öffnungsstatus (siehe
                  // createClusterIcon) — Leaflet-Marker kennen dieses Feld
                  // nicht von sich aus.
                  (ref as VenueStatusMarker).venueOpen = venue.open;
                }
              }}
            >
              <Popup minWidth={200}>
                <View style={styles.popup}>
                  {venue.image_url && <Image source={{ uri: venue.image_url }} style={styles.popupImage} />}
                  <View style={styles.popupHeaderRow}>
                    <Text style={styles.popupTitle}>{venue.name}</Text>
                    {venue.open === true && <Text style={styles.openBadge}>Geöffnet</Text>}
                    {venue.open === false && <Text style={styles.closedBadge}>Geschlossen</Text>}
                  </View>
                  {venue.address && <Text style={styles.popupAddress}>{venue.address}</Text>}
                  {hoursToday && <Text style={styles.popupHours}>Heute: {hoursToday}</Text>}
                  {venue.website && (
                    <Pressable onPress={() => window.open(venue.website!, '_blank')}>
                      <Text style={styles.popupLink}>Website öffnen</Text>
                    </Pressable>
                  )}
                  <Pressable onPress={() => window.open(googleMapsUrl(venue.latitude, venue.longitude, venue.name, venue.address), '_blank')}>
                    <Text style={styles.popupMapsButton}>In Google Maps öffnen</Text>
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
              die eigentlich einem darunterliegenden Marker galten — genau der
              Fall bei Restaurants nah an der eigenen Position, die sich
              dadurch nicht mehr öffnen ließen. */}
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
      <FocusTarget targetId={targetId} targetLat={targetId ? centerLat : null} targetLng={targetId ? centerLng : null} markerRefs={markerRefs} />
    </MapContainer>
  );
}

const styles = StyleSheet.create({
  map: { flex: 1, width: '100%', height: '100%' },
  popup: { minWidth: 200, padding: 4 },
  popupImage: { width: '100%', height: 90, borderRadius: 8, marginBottom: 6 },
  popupHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  popupTitle: { fontWeight: '700', fontSize: 14, color: '#000' },
  openBadge: { fontSize: 10, fontWeight: '700', color: '#1a7a3d', backgroundColor: '#4ade8033', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  closedBadge: { fontSize: 10, fontWeight: '700', color: '#b3261e', backgroundColor: '#ff6b6b33', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  popupAddress: { fontSize: 12, color: '#444' },
  popupHours: { fontSize: 12, color: '#444', marginTop: 2 },
  popupLink: { fontSize: 12, color: '#0af', fontWeight: '600', marginTop: 6 },
  popupMapsButton: { fontSize: 12, color: '#0af', fontWeight: '600', marginTop: 4 },
});
