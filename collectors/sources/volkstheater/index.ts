import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { getCoordinates } from '../../core/geocode';
import { extractJsonLdEvents, extractInMuenchenTeasers, parseGermanDate, checkInMuenchenFreeEntry, buildStableSourceId, dedupeBySourceId } from '../../core/scrape';

// Münchner Volkstheater hat keine eigene scrapbare Programmseite; die
// in-muenchen.de-Locationseite listet dieselben Termine serverseitig
// gerendert (20 Events bei Verifikation, Stand 2026-07).
const VOLKSTHEATER_URL = 'https://www.in-muenchen.de/locations/munchner-volkstheater.html';
const VOLKSTHEATER_ADDRESS = 'Brienner Straße 50, 80333 München';

export async function run() {
  console.log('[volkstheater] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[volkstheater] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const collected: any[] = [];
  const today = new Date().toISOString().slice(0, 10);

  try {
    console.log('[volkstheater] fetching', VOLKSTHEATER_URL);
    const res = await fetch(VOLKSTHEATER_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) { console.warn('[volkstheater] fetch failed', res.status); return; }
    const html = await res.text();
    const $ = cheerio.load(html);

    const events = extractJsonLdEvents($);
    if (!events.length) events.push(...extractInMuenchenTeasers($, VOLKSTHEATER_URL));

    for (const ev of events) {
      let start_date: string | null = null;
      let start_time: string | null = null;
      if (ev.startDate) {
        const d = new Date(ev.startDate);
        if (!isNaN(d.getTime())) {
          start_date = d.toISOString().slice(0, 10);
          start_time = d.toISOString().slice(11, 16);
        } else {
          start_date = parseGermanDate(ev.startDate);
          const timeMatch = ev.startDate.match(/(\d{1,2}):(\d{2})\s*Uhr/);
          if (timeMatch) start_time = `${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}`;
        }
      }
      if (!ev.name || !start_date || start_date < today) continue;

      const eventUrl = ev.url ?? VOLKSTHEATER_URL;
      const sourceId = buildStableSourceId('volkstheater', String(eventUrl), start_date);
      const coords = await getCoordinates(supabase, 'Münchner Volkstheater', VOLKSTHEATER_ADDRESS, 'München');
      const price_info = await checkInMuenchenFreeEntry(eventUrl);

      collected.push({
        source_id: sourceId,
        title: ev.name,
        description: ev.description,
        category: 'Theater',
        subcategory: null,
        start_date,
        start_time,
        location_name: 'Münchner Volkstheater',
        address: VOLKSTHEATER_ADDRESS,
        city: 'München',
        organizer: ev.organizer ?? 'Münchner Volkstheater',
        source_url: eventUrl,
        image_url: ev.image,
        price_info,
        latitude: coords?.latitude ?? null,
        longitude: coords?.longitude ?? null,
      });
    }
  } catch (err) {
    console.warn('[volkstheater] error', err);
  }

  if (collected.length === 0) { console.log('[volkstheater] no events parsed'); return; }
  console.log('[volkstheater] upserting', collected.length, 'events');
  const { error } = await supabase.from('events').upsert(dedupeBySourceId(collected), { onConflict: 'source_id' });
  if (error) console.error('[volkstheater] upsert error', error);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

export default run;
