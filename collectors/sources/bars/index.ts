import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';

// OpenStreetMap/Overpass statt eines Ticketing-Collectors: eine Bar ist ein
// Ort mit regulären Öffnungszeiten, kein einzelner Termin, und dafür gibt es
// bei den bisherigen Quellen keine Entsprechung. Overpass ist kostenlos,
// braucht keinen API-Key, und München ist gut gepflegt: 585 amenity=bar/pub-
// Knoten gefunden, davon ~67% mit einem opening_hours-Tag (per Direktabruf
// verifiziert, 2026-07).
const OVERPASS_URL = 'https://overpass.kumi.systems/api/interpreter';
// Bounding Box um München (Stadtgebiet + etwas Umland) statt Namens-Lookup
// (area["name"="München"]["admin_level"=...] ist je nach OSM-Relation
// fehleranfällig — lieferte beim Direktabruf 406 statt Daten).
const MUNICH_BBOX = '48.0616,11.3600,48.2482,11.7228';
const OVERPASS_QUERY = `
[out:json][timeout:25];
(
  node["amenity"="bar"](${MUNICH_BBOX});
  node["amenity"="pub"](${MUNICH_BBOX});
);
out body;
`;

interface OverpassElement {
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

function buildAddress(tags: Record<string, string>): string | null {
  const streetLine = [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ');
  const cityLine = [tags['addr:postcode'], tags['addr:city']].filter(Boolean).join(' ');
  const parts = [streetLine, cityLine].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

export async function run() {
  console.log('[bars] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[bars] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'User-Agent': 'VibeApp-Collector/1.0 (nicht-kommerziell, github.com/Lelawi/Vibe)',
      },
      body: 'data=' + encodeURIComponent(OVERPASS_QUERY),
    });
    if (!res.ok) { console.warn('[bars] overpass fetch failed', res.status); return; }

    const data = (await res.json()) as { elements: OverpassElement[] };
    const bars = data.elements
      .filter((el) => el.tags?.name)
      .map((el) => {
        const tags = el.tags!;
        return {
          osm_id: el.id,
          name: tags.name,
          address: buildAddress(tags),
          latitude: el.lat,
          longitude: el.lon,
          opening_hours_raw: tags.opening_hours ?? null,
          website: tags.website ?? tags['contact:website'] ?? null,
          phone: tags.phone ?? tags['contact:phone'] ?? null,
          updated_at: new Date().toISOString(),
        };
      });

    if (bars.length === 0) { console.log('[bars] no bars parsed'); return; }
    console.log('[bars] upserting', bars.length, 'bars');
    const { error } = await supabase.from('bars').upsert(bars, { onConflict: 'osm_id' });
    if (error) console.error('[bars] upsert error', error);
  } catch (err) {
    console.warn('[bars] error', err);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}

export default run;
