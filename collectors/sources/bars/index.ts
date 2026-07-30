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

// OSM selbst pflegt so gut wie nie ein "image"-Tag auf Bar-Knoten, aber viele
// Bars haben eine eigene Website mit og:image (dieselbe Quelle nutzen z.B.
// sources/auer_dult, sources/milla). Best effort: schlägt der Abruf fehl
// oder gibt es kein og:image, bleibt image_url einfach null — keine Bar soll
// deswegen aus dem Lauf rausfallen.
async function fetchOgImage(website: string): Promise<string | null> {
  try {
    const res = await fetch(website, {
      headers: { 'User-Agent': 'VibeApp-Collector/1.0 (nicht-kommerziell, github.com/Lelawi/Vibe)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (!match) return null;
    // Relative og:image-URLs (z.B. "/images/hero.jpg") kommen vor —
    // gegen die Website-URL auflösen statt kaputte relative Pfade zu speichern.
    return new URL(match[1], website).toString();
  } catch {
    return null;
  }
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
    const rawBars = data.elements
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

    if (rawBars.length === 0) { console.log('[bars] no bars parsed'); return; }

    // Bereits vorhandene image_url je osm_id wiederverwenden statt bei jedem
    // (wöchentlichen) Lauf alle Websites erneut abzuklappern — nur für Bars
    // ohne bekanntes Bild wird neu gefetcht.
    const { data: existing } = await supabase.from('bars').select('osm_id,image_url');
    const existingImageByOsmId = new Map((existing ?? []).map((b) => [b.osm_id as number, b.image_url as string | null]));

    const toFetch = rawBars.filter((b) => b.website && !existingImageByOsmId.get(b.osm_id));
    console.log('[bars] fetching og:image for', toFetch.length, 'bars without a known image');
    const imageByOsmId = new Map<number, string | null>();
    const CONCURRENCY = 6;
    let cursor = 0;
    async function worker() {
      while (cursor < toFetch.length) {
        const bar = toFetch[cursor++];
        imageByOsmId.set(bar.osm_id, await fetchOgImage(bar.website!));
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    const bars = rawBars.map((b) => ({
      ...b,
      image_url: imageByOsmId.get(b.osm_id) ?? existingImageByOsmId.get(b.osm_id) ?? null,
    }));

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
