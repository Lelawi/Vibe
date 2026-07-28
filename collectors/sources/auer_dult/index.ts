import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { getCoordinates } from '../../core/geocode';
import { parseGermanDate } from '../../core/scrape';

// Die Auer Dult findet 3x im Jahr auf dem Mariahilfplatz statt (Maidult,
// Jakobidult, Kirchweihdult). Die offizielle Seite listet die Termine als
// Fließtext statt strukturierter Daten, daher wird hier nach den bekannten
// Namen gesucht und das erste Datum danach geparst.
const AUER_DULT_URL = 'https://www.auerdult.de/dultinfo';
const AUER_DULT_ADDRESS = 'Mariahilfplatz, 81541 München';
const DULT_NAMES = ['Maidult', 'Jakobidult', 'Kirchweihdult'];

export async function run() {
  console.log('[auer-dult] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[auer-dult] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const collected: any[] = [];

  try {
    console.log('[auer-dult] fetching', AUER_DULT_URL);
    const res = await fetch(AUER_DULT_URL, { headers: { 'User-Agent': 'VibeApp-Collector/1.0' } });
    if (!res.ok) { console.warn('[auer-dult] fetch failed', res.status); return; }
    const html = await res.text();
    const $ = cheerio.load(html);
    const text = $('body').text().replace(/\s+/g, ' ');

    const coords = await getCoordinates(supabase, 'Auer Dult', AUER_DULT_ADDRESS, 'München');

    for (const dultName of DULT_NAMES) {
      const idx = text.indexOf(dultName);
      if (idx === -1) continue;
      // Sucht im Text nach dem Dult-Namen den ersten Tag, den ersten Monatsnamen
      // und die erste Jahreszahl danach — reicht, um den Beginn des Datums-
      // bereichs zu bestimmen, z.B. "25. April bis 3. Mai 2026" -> 25. April 2026
      const window = text.slice(idx, idx + 200);
      const dayMatch = window.match(/(\d{1,2})\./);
      const monthMatch = window.match(/(januar|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember)/i);
      const yearMatch = window.match(/(\d{4})/);
      if (!dayMatch || !monthMatch || !yearMatch) continue;

      const start_date = parseGermanDate(`${dayMatch[1]}. ${monthMatch[1]} ${yearMatch[1]}`);
      if (!start_date) continue;

      const sourceId = `auer-dult-${dultName.toLowerCase()}-${yearMatch[1]}`;
      collected.push({
        source_id: sourceId,
        title: `${dultName} auf dem Mariahilfplatz`,
        description: `Termin laut ${AUER_DULT_URL}: ${window.trim().slice(0, 150)}`,
        category: 'Märkte',
        subcategory: 'Dult',
        start_date,
        start_time: null,
        location_name: 'Auer Dult',
        address: AUER_DULT_ADDRESS,
        city: 'München',
        organizer: 'Landeshauptstadt München',
        source_url: AUER_DULT_URL,
        image_url: null,
        latitude: coords?.latitude ?? null,
        longitude: coords?.longitude ?? null,
      });
    }
  } catch (err) {
    console.warn('[auer-dult] error', err);
  }

  if (collected.length === 0) { console.log('[auer-dult] no events parsed'); return; }
  console.log('[auer-dult] upserting', collected.length, 'events');
  const { error } = await supabase.from('events').upsert(collected, { onConflict: 'source_id' });
  if (error) console.error('[auer-dult] upsert error', error);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

export default run;
