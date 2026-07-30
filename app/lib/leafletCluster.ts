import L from 'leaflet';

// Cluster-Icons im App-Look statt der Standard-Gelb/Orange-Kreise von
// leaflet.markercluster, die farblich nicht zum dunklen Purple/Blau-Theme
// passen. Geteilt zwischen der Events- und der Venues-Karte (beide nutzen
// react-leaflet-cluster für dieselbe "Marker rasten beim Herauszoomen zu
// unlesbaren Flecken" Problematik).
export function createClusterIcon(cluster: { getChildCount: () => number }): L.DivIcon {
  const count = cluster.getChildCount();
  const size = count < 10 ? 34 : count < 100 ? 40 : 46;
  return L.divIcon({
    className: 'vibe-cluster-marker',
    html: `<div style="width:${size}px;height:${size}px;border-radius:${size / 2}px;background:#0af;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;"><span style="color:#000;font-weight:700;font-size:${count < 100 ? 13 : 11}px;font-family:sans-serif;">${count}</span></div>`,
    iconSize: L.point(size, size, true),
  });
}
