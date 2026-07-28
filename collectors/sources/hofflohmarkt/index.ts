import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { getCoordinates } from '../../core/geocode';

// Hofflohmärkte München: an wechselnden Terminen öffnen alle Höfe eines
// Stadtviertels gleichzeitig für einen Flohmarkt. Bundesweiter Veranstalter
// (hofflohmaerkte.de) veröffentlicht die Münchner Termine als Fließtext
// (Datum · Viertel (Uhrzeit)), kein strukturiertes Markup — daher Text-Parsing
// statt CSS-Selektoren, ähnlich wie bei auer_dult.
const HOFFLOHMARKT_URL = 'https://www.hofflohmaerkte.de/pages/hofflohmarkte-munchen';

const GERMAN_MONTHS: Record<string, number> = {
  januar: 1, februar: 2, märz: 3, april: 4, mai: 5, juni: 6, juli: 7,
  august: 8, september: 9, oktober: 10, november: 11, dezember: 12,
};

// Matched z.B. "31. Juli · Kieferngarten (17-22 Uhr)" oder "12. September ·
// Ramersdorf (10-16 Uhr)" — Datum, Viertelname, Startzeit.
const ENTRY_PATTERN =
  /(\d{1,2})\.\s*(Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\s*[·:\-–]?\s*([A-ZÄÖÜ][\wäöüßÄÖÜ&.\- ]{2,40}?)\s*\((\d{1,2})(?::\d{2})?\s*[-–]\s*\d{1,2}(?::\d{2})?\s*Uhr\)/g;

export async function run() {
  console.log('[hofflohmarkt] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[hofflohmarkt] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const collected: any[] = [];
  const today = new Date().toISOString().slice(0, 10);

  try {
    console.log('[hofflohmarkt] fetching', HOFFLOHMARKT_URL);
    const res = await fetch(HOFFLOHMARKT_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) { console.warn('[hofflohmarkt] fetch failed', res.status); return; }
    const html = await res.text();
    const $ = cheerio.load(html);
    const text = $('body').text().replace(/\s+/g, ' ');

    const now = new Date();
    const seen = new Set<string>();

    for (const match of text.matchAll(ENTRY_PATTERN)) {
      const [, dayStr, monthName, districtRaw, hourStr] = match;
      const day = parseInt(dayStr, 10);
      const month = GERMAN_MONTHS[monthName.toLowerCase()];
      const district = districtRaw.trim();
      if (!district || district.length < 3) continue;

      let year = now.getFullYear();
      let candidate = new Date(year, month - 1, day);
      if (candidate < now) {
        year += 1;
        candidate = new Date(year, month - 1, day);
      }
      const start_date = candidate.toISOString().slice(0, 10);
      if (start_date < today) continue;

      const dedupeKey = `${district}-${start_date}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const locationName = `Hofflohmarkt ${district}`;
      const coords = await getCoordinates(supabase, `${district}, München`, null, 'München');

      collected.push({
        source_id: `hofflohmarkt-${district.toLowerCase().replace(/[^a-zäöüß0-9]+/g, '-')}-${start_date}`,
        title: locationName,
        description: `Nachbarschafts-Flohmarkt im Viertel ${district} — Details/Tourplan auf ${HOFFLOHMARKT_URL}`,
        category: 'Märkte',
        subcategory: 'Hofflohmarkt',
        start_date,
        start_time: `${hourStr.padStart(2, '0')}:00`,
        location_name: locationName,
        address: null,
        city: 'München',
        organizer: 'hofflohmaerkte.de',
        source_url: HOFFLOHMARKT_URL,
        image_url: null,
        latitude: coords?.latitude ?? null,
        longitude: coords?.longitude ?? null,
      });
    }
  } catch (err) {
    console.warn('[hofflohmarkt] error', err);
  }

  if (collected.length === 0) { console.log('[hofflohmarkt] no events parsed'); return; }
  console.log('[hofflohmarkt] upserting', collected.length, 'events');
  const { error } = await supabase.from('events').upsert(collected, { onConflict: 'source_id' });
  if (error) console.error('[hofflohmarkt] upsert error', error);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

export default run;
