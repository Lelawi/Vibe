import { fileURLToPath } from 'url';
import { collectVenues } from '../../core/venues';

// OpenStreetMap/Overpass statt eines Ticketing-Collectors: eine Bar ist ein
// Ort mit regulären Öffnungszeiten, kein einzelner Termin, und dafür gibt es
// bei den bisherigen Quellen keine Entsprechung. Overpass ist kostenlos,
// braucht keinen API-Key, und München ist gut gepflegt: 585 amenity=bar/pub-
// Knoten gefunden, davon ~67% mit einem opening_hours-Tag (per Direktabruf
// verifiziert, 2026-07). Teilt sich die eigentliche Sammel-/Anreicherungs-
// logik mit sources/restaurants über core/venues.ts (0015_venues_generalize_
// for_restaurants.sql).
export async function run() {
  await collectVenues({ label: 'bars', type: 'bar', amenityValues: ['bar', 'pub'] });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}

export default run;
