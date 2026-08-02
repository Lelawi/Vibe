import { fileURLToPath } from 'url';
import { collectVenues } from '../../core/venues';

// Selbe Grundlage wie sources/bars (OSM/Overpass, siehe core/venues.ts) —
// amenity=restaurant statt bar/pub, gespeichert in derselben generischen
// venues-Tabelle mit type='restaurant' (0015_venues_generalize_for_
// restaurants.sql). amenity=cafe bewusst mit rein (statt einer eigenen
// vierten Kategorie, per Nutzer-Entscheidung 2026-08-02) — Cafés bekamen
// sonst gar keine Kategorie und fehlten komplett (Café Spatz-Fall).
export async function run() {
  await collectVenues({ label: 'restaurants', type: 'restaurant', amenityValues: ['restaurant', 'cafe'] });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}

export default run;
