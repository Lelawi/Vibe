import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { getCoordinates } from '../../core/geocode';
import { buildStableSourceId, dedupeBySourceId } from '../../core/scrape';

// Kino, Mond & Sterne (Open-Air-Kino Seebühne Westpark) betreibt eine
// Vue.js-SPA — im Server-HTML steht kein einziger Termin (gleiches
// strukturelles Problem wie ampere/lmu/eventfrog, siehe Kommentar in
// collect-all.ts). Anders als bei diesen liefert die SPA hier aber ihre
// Daten von einer öffentlichen, direkt abrufbaren JSON-API (gefunden über
// die axios-baseURL im ausgelieferten app.js-Bundle: "https://www.
// kino-mond-sterne.de/api"), die exakt dieselben Daten liefert wie die
// Website selbst rendert — kein Headless-Browser nötig.
const KMS_API = 'https://www.kino-mond-sterne.de/api/projections';
const KMS_ADDRESS = 'Auf der Seebühne im Westpark, 81377 München';
const KMS_LOCATION = 'Kino, Mond & Sterne (Seebühne Westpark)';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Die API liefert keine Uhrzeit pro Vorstellung, nur das Datum — laut
// offizieller Programm-Info startet die Vorstellung im August um 21:00 Uhr,
// ab September (kürzere Tage) um 20:15 Uhr. Für Monate davor (Juni/Juli,
// noch Sommerzeit-Dämmerung) gilt praktisch dieselbe 21:00-Regel.
function startTimeForMonth(monthValue: string): string {
  return monthValue === '09' ? '20:15' : '21:00';
}

type KmsItem = {
  dt: { d: string; m: string; y: string };
  movie: {
    t: string;
    s: string;
    d?: string | null;
    p?: { u?: string | null } | null;
    m?: { u?: string | null } | null;
  };
};
type KmsMonth = { month: string; monthValue: string; items: KmsItem[] };

export async function run() {
  console.log('[kino-mond-sterne] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[kino-mond-sterne] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const today = new Date().toISOString().slice(0, 10);
  const collected: any[] = [];
  const coords = await getCoordinates(supabase, KMS_LOCATION, KMS_ADDRESS, 'München');

  try {
    console.log('[kino-mond-sterne] fetching', KMS_API);
    const res = await fetch(KMS_API, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    if (!res.ok) { console.warn('[kino-mond-sterne] fetch failed', res.status); return; }
    const json = (await res.json()) as { data?: KmsMonth[] };

    for (const monthGroup of json.data ?? []) {
      const startTime = startTimeForMonth(monthGroup.monthValue);
      for (const item of monthGroup.items ?? []) {
        const start_date = `${item.dt.y}-${item.dt.m}-${item.dt.d}`;
        if (start_date < today) continue;
        // "Ausverkauft. <Titel>"-Präfix (Vorstellung ist ausverkauft, findet
        // aber trotzdem statt) für einen sauberen Titel abtrennen.
        const title = item.movie.t.replace(/^Ausverkauft\.\s*/i, '').trim();
        if (!title) continue;

        const image = item.movie.p?.u ?? item.movie.m?.u ?? null;
        const description = item.movie.d
          ? item.movie.d.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim().slice(0, 500)
          : null;
        const sourceUrl = `https://www.kino-mond-sterne.de/programm/${item.movie.s}`;
        // Slug allein reicht nicht als Konflikt-Key (derselbe Film läuft oft
        // an mehreren Terminen) — Datum mit reinnehmen, wie buildStableSourceId
        // es ohnehin selbst anhängt, damit auch der Hash-Teil pro Termin
        // eindeutig ist.
        const sourceId = buildStableSourceId('kino-mond-sterne', `${item.movie.s}-${start_date}`, start_date);

        collected.push({
          source_id: sourceId,
          title,
          description,
          category: 'Kultur',
          subcategory: 'Kino',
          start_date,
          end_date: null,
          start_time: startTime,
          location_name: KMS_LOCATION,
          address: KMS_ADDRESS,
          city: 'München',
          organizer: 'Kino, Mond & Sterne',
          source_url: sourceUrl,
          image_url: image,
          price_info: 'ab 9,50 €',
          latitude: coords?.latitude ?? null,
          longitude: coords?.longitude ?? null,
        });
      }
    }
  } catch (err) {
    console.warn('[kino-mond-sterne] error', err);
  }

  if (collected.length === 0) { console.log('[kino-mond-sterne] no events parsed'); return; }
  console.log('[kino-mond-sterne] upserting', collected.length, 'events');
  const { error } = await supabase.from('events').upsert(dedupeBySourceId(collected), { onConflict: 'source_id' });
  if (error) console.error('[kino-mond-sterne] upsert error', error);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

export default run;
