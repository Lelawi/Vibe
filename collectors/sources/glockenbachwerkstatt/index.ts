import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { getCoordinates } from '../../core/geocode';

// Bürgerhaus Glockenbachwerkstatt — Struktur per direktem HTML-Abruf
// verifiziert (2026-07): <div class="event"> mit <span class="imgdate">D.M.</span>
// (ohne Jahr), <span class="eventtime">HH:MM Uhr</span>, <h2 class="event__title">.
const GLOCKENBACH_URL = 'https://www.glockenbachwerkstatt.de/veranstaltungen/';
const GLOCKENBACH_ADDRESS = 'Blumenstraße 7, 80331 München';

export async function run() {
  console.log('[glockenbachwerkstatt] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[glockenbachwerkstatt] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const collected: any[] = [];
  const today = new Date().toISOString().slice(0, 10);

  try {
    console.log('[glockenbachwerkstatt] fetching', GLOCKENBACH_URL);
    const res = await fetch(GLOCKENBACH_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) { console.warn('[glockenbachwerkstatt] fetch failed', res.status); return; }
    const html = await res.text();
    const $ = cheerio.load(html);
    const coords = await getCoordinates(supabase, 'Glockenbachwerkstatt', GLOCKENBACH_ADDRESS, 'München');

    const now = new Date();

    $('.event').each((_, el) => {
      const el$ = $(el);
      const title = el$.find('.event__title a span').first().text().trim() || el$.find('.event__title a').first().text().trim();
      const href = el$.find('.event__title a').first().attr('href');
      const dateText = el$.find('.imgdate').first().text().trim(); // z.B. "29.7."
      const timeText = el$.find('.eventtime').first().text().trim(); // z.B. "20:30 Uhr"
      if (!title || !href || !dateText) return;

      const dateMatch = dateText.match(/(\d{1,2})\.(\d{1,2})\./);
      if (!dateMatch) return;
      const [, dayStr, monthStr] = dateMatch;
      const day = parseInt(dayStr, 10);
      const month = parseInt(monthStr, 10);

      let year = now.getFullYear();
      let candidate = new Date(year, month - 1, day);
      if (candidate < now) {
        year += 1;
        candidate = new Date(year, month - 1, day);
      }
      const start_date = candidate.toISOString().slice(0, 10);
      if (start_date < today) return;

      const timeMatch = timeText.match(/(\d{1,2}):(\d{2})/);
      const start_time = timeMatch ? `${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}` : null;
      const price_info = el$.find('.eventtime.price').first().text().trim() || null;

      collected.push({
        source_id: `glockenbachwerkstatt-${href.split('/').filter(Boolean).pop()}`,
        title,
        description: null,
        category: 'Konzerte',
        subcategory: null,
        start_date,
        start_time,
        location_name: 'Glockenbachwerkstatt',
        address: GLOCKENBACH_ADDRESS,
        city: 'München',
        organizer: 'Glockenbachwerkstatt',
        source_url: new URL(href, GLOCKENBACH_URL).toString(),
        image_url: null,
        price_info,
        sold_out: null,
        latitude: coords?.latitude ?? null,
        longitude: coords?.longitude ?? null,
      });
    });
  } catch (err) {
    console.warn('[glockenbachwerkstatt] error', err);
  }

  if (collected.length === 0) { console.log('[glockenbachwerkstatt] no events parsed'); return; }
  console.log('[glockenbachwerkstatt] upserting', collected.length, 'events');
  const { error } = await supabase.from('events').upsert(collected, { onConflict: 'source_id' });
  if (error) console.error('[glockenbachwerkstatt] upsert error', error);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

export default run;
