import { fileURLToPath } from 'url';
import { collectVenues } from '../../core/venues';

// Spontane "wo ist der nächste Späti"-Suche unterwegs (Nutzer-Anfrage) —
// dieselbe OSM/Overpass-Grundlage wie Bars/Restaurants, aber über den
// shop=-Tag statt amenity=, da Kioske/Convenience-Shops in OSM als Shop
// klassifiziert sind: 432 benannte shop=kiosk|convenience|alcohol-Knoten in
// München gefunden, davon 75% mit einem opening_hours-Tag, aber nur ~17%
// mit einer Website (per Direktabruf verifiziert, 2026-07) — entsprechend
// niedrigere Bild-/Bierpreis-Trefferquote als bei Bars/Restaurants zu
// erwarten, Öffnungszeiten (der eigentliche Zweck) sind aber gut abgedeckt.
export async function run() {
  await collectVenues({
    label: 'spaetis',
    type: 'spaeti',
    tagKey: 'shop',
    amenityValues: ['kiosk', 'convenience', 'alcohol'],
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}

export default run;
