import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import { collectVenues } from '../../core/venues';
import { getCoordinates } from '../../core/geocode';

// Neueröffnung vom 10.06.2026, noch nicht unter diesem Namen in OSM
// vorhanden (Live-DB/OSM-Abgleich am 04.08.2026). Negative IDs sind bewusst
// für eng kuratierte Fallbacks reserviert und kollidieren nie mit echten
// positiven OSM-Node-IDs. Sobald OSM den Ort enthält, kann dieser Eintrag
// entfernt und die synthetische Zeile einmalig bereinigt werden.
const CURATED_NEW_VENUES = [
  {
    osm_id: -2026061001,
    name: 'Café Spatz',
    address: 'Gollierstraße 53, 80339 München',
    website: 'https://cafespatz.net',
    opening_hours_raw: 'We-Su 10:00-17:00',
  },
  {
    // Per Nutzer-Fund (2026-08-08, Google-Maps-Link) noch nicht in OSM
    // erfasst — keine eigene Website auffindbar (nur Uber Eats/Instagram),
    // daher website: null statt eines Aggregator-Links.
    osm_id: -2026080801,
    name: 'UME Umami Bowls & Vietnamese Coffee',
    address: 'Steinheilstraße 21, 80333 München',
    website: null,
    opening_hours_raw: null,
  },
  {
    // Per Nutzer-Fund (2026-08-08, Google-Maps-Link) noch nicht in OSM
    // erfasst. Der Google-Maps-Eintrag selbst zeigt "Dream Corner" als
    // Namen, mehrere unabhängige Quellen (eigene Website-Domain
    // coffeedream-mnchen.de, Lieferando, mehrere Online-Speisekarten)
    // nennen dieselbe Adresse aber konsistent "Coffee Dream" — hier
    // übernommen, falls tatsächlich zu "Dream Corner" umbenannt wurde bitte
    // korrigieren.
    osm_id: -2026080802,
    name: 'Coffee Dream',
    address: 'Bergmannstraße 23, 80339 München',
    website: 'https://www.coffeedream-mnchen.de',
    opening_hours_raw: null,
  },
];

// Selbe Grundlage wie sources/bars (OSM/Overpass, siehe core/venues.ts) —
// amenity=restaurant statt bar/pub, gespeichert in derselben generischen
// venues-Tabelle mit type='restaurant' (0015_venues_generalize_for_
// restaurants.sql). amenity=cafe bewusst mit rein (statt einer eigenen
// vierten Kategorie, per Nutzer-Entscheidung 2026-08-02) — Cafés bekamen
// sonst gar keine Kategorie und fehlten komplett (Café Spatz-Fall).
export async function run() {
  await collectVenues({ label: 'restaurants', type: 'restaurant', amenityValues: ['restaurant', 'cafe'] });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) return;
  const supabase = createClient(supabaseUrl, supabaseKey);
  for (const venue of CURATED_NEW_VENUES) {
    const coords = await getCoordinates(supabase, venue.name, venue.address, 'München');
    const { error } = await supabase.from('venues').upsert({
      ...venue,
      type: 'restaurant',
      latitude: coords?.latitude ?? null,
      longitude: coords?.longitude ?? null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'osm_id' });
    if (error) console.error(`[restaurants] curated upsert failed for ${venue.name}`, error);
    else console.log(`[restaurants] curated venue saved/updated: ${venue.name}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}

export default run;
