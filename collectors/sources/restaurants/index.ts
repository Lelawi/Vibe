import { fileURLToPath } from 'url';
import { collectVenues } from '../../core/venues';

// Selbe Grundlage wie sources/bars (OSM/Overpass, siehe core/venues.ts) —
// amenity=restaurant statt bar/pub, gespeichert in derselben generischen
// venues-Tabelle mit type='restaurant' (0015_venues_generalize_for_
// restaurants.sql).
export async function run() {
  await collectVenues({ label: 'restaurants', type: 'restaurant', amenityValues: ['restaurant'] });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}

export default run;
