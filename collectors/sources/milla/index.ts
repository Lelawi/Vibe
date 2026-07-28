import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { getCoordinates } from '../../core/geocode';
import { extractJsonLdEvents, parseGermanDate } from '../../core/scrape';

const MILLA_URL = 'https://milla-club.de/category/event/';
const MILLA_ADDRESS = 'Holzstraße 28, 80469 München';

export async function run() {
  console.log('[milla] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[milla] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const collected: any[] = [];

  try {
    console.log('[milla] fetching', MILLA_URL);
    const res = await fetch(MILLA_URL, { headers: { 'User-Agent': 'VibeApp-Collector/1.0' } });
    if (!res.ok) { console.warn('[milla] fetch failed', res.status); return; }
    const html = await res.text();
    const $ = cheerio.load(html);

    const events = extractJsonLdEvents($);

    // WordPress-Blog/Kategorie-Archiv als Fallback: jeder Artikel ist ein Event-Post
    if (!events.length) {
      $('article, .post').each((_, el) => {
        const el$ = $(el);
        const name = el$.find('h1, h2, .entry-title').first().text().trim();
        const dateText = el$.find('time').attr('datetime') || el$.find('time').text().trim() || el$.text();
        const href = el$.find('a').first().attr('href');
        if (!name || !href) return;
        events.push({
          name,
          startDate: dateText || null,
          description: null,
          url: new URL(href, MILLA_URL).toString(),
          image: el$.find('img').attr('src') ?? null,
          locationName: 'Milla Club',
          address: MILLA_ADDRESS,
          organizer: 'Milla Club',
        });
      });
    }

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
        }
      }
      if (!ev.name || !start_date) continue;

      const eventUrl = ev.url ?? MILLA_URL;
      const sourceId = `milla-${Buffer.from(String(eventUrl)).toString('base64').slice(0, 20)}`;
      const coords = await getCoordinates(supabase, 'Milla Club', MILLA_ADDRESS, 'München');

      collected.push({
        source_id: sourceId,
        title: ev.name,
        description: ev.description,
        category: 'Clubs',
        subcategory: null,
        start_date,
        start_time,
        location_name: 'Milla Club',
        address: MILLA_ADDRESS,
        city: 'München',
        organizer: ev.organizer ?? 'Milla Club',
        source_url: eventUrl,
        image_url: ev.image,
        latitude: coords?.latitude ?? null,
        longitude: coords?.longitude ?? null,
      });
    }
  } catch (err) {
    console.warn('[milla] error', err);
  }

  if (collected.length === 0) { console.log('[milla] no events parsed'); return; }
  console.log('[milla] upserting', collected.length, 'events');
  const { error } = await supabase.from('events').upsert(collected, { onConflict: 'source_id' });
  if (error) console.error('[milla] upsert error', error);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

export default run;
