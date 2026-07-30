import L from 'leaflet';

// Custom-Feld auf dem Leaflet-Marker, um den Öffnungsstatus des dahinter-
// liegenden Venues verlustfrei bis in iconCreateFunction zu tragen — Leaflet-
// Marker selbst kennen kein "offen/geschlossen", das ist reine App-Semantik
// (siehe VenueLeafletView.web.tsx, wo dieses Feld beim Erzeugen gesetzt wird).
export type VenueStatusMarker = L.Marker & { venueOpen?: boolean | null };

// Cluster-Icons im App-Look statt der Standard-Gelb/Orange-Kreise von
// leaflet.markercluster, die farblich nicht zum dunklen Purple/Blau-Theme
// passen. Geteilt zwischen der Events- und der Venues-Karte (beide nutzen
// react-leaflet-cluster für dieselbe "Marker rasten beim Herauszoomen zu
// unlesbaren Flecken" Problematik).
//
// Färbt den Cluster nach der Mehrheit der offen/geschlossen-Status seiner
// Kind-Marker (Grün/Rot/Gelb bei gemischt) statt immer einheitlich Blau —
// sonst geht durch die Bündelung genau das Signal verloren, das die
// einzelnen Marker-Farben eigentlich zeigen sollen (Nutzer-Feedback: "durch
// die Bündelung sieht man nicht mehr so leicht, welche davon offen sind").
// Bei Events (keine venueOpen-Daten) bleibt es beim neutralen Blau.
export function createClusterIcon(cluster: { getChildCount: () => number; getAllChildMarkers: () => VenueStatusMarker[] }): L.DivIcon {
  const count = cluster.getChildCount();
  const size = count < 10 ? 34 : count < 100 ? 40 : 46;

  let openCount = 0;
  let closedCount = 0;
  for (const marker of cluster.getAllChildMarkers()) {
    if (marker.venueOpen === true) openCount++;
    else if (marker.venueOpen === false) closedCount++;
  }
  const knownCount = openCount + closedCount;
  let color = '#0af';
  if (knownCount > 0) {
    const openRatio = openCount / knownCount;
    color = openRatio >= 0.7 ? '#4ade80' : openRatio <= 0.3 ? '#ff6b6b' : '#f2c94c';
  }

  return L.divIcon({
    className: 'vibe-cluster-marker',
    html: `<div style="width:${size}px;height:${size}px;border-radius:${size / 2}px;background:${color};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;"><span style="color:#000;font-weight:700;font-size:${count < 100 ? 13 : 11}px;font-family:sans-serif;">${count}</span></div>`,
    iconSize: L.point(size, size, true),
  });
}
