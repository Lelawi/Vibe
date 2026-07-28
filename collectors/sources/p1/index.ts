import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { getCoordinates } from '../../core/geocode';
import { extractJsonLdEvents, parseGermanDate } from '../../core/scrape';

// P1 selbst betreibt keine öffentliche Event-Seite (nur Corporate-Events-Seite
// ohne Programm) — die einzige strukturierte, frei zugängliche Quelle für das
// Clubprogramm ist die venue-spezifische Seite auf muenchen.de.
const P1_URL = 'https://www.muenchen.de/veranstaltungen/discos-und-clubs/p1-club';
const P1_ADDRESS = 'Prinzregentenstraße 1, 80538 München';

export async function run() {
  console.log('[p1] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[p1] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const collected: any[] = [];

  try {
    console.log('[p1] fetching', P1_URL);
    const res = await fetch(P1_URL, { headers: { 'User-Agent': 'VibeApp-Collector/1.0' } });
    if (!res.ok) { console.warn('[p1] fetch failed', res.status); return; }
    const html = await res.text();
    const $ = cheerio.load(html);

    const events = extractJsonLdEvents($);

    if (!events.length) {
      $('a[href*="/veranstaltung"], article, .event-teaser').each((_, el) => {
        const el$ = $(el);
        const name = el$.find('h1, h2, h3').first().text().trim();
        const dateText = el$.find('time').attr('datetime') || el$.find('time').text().trim();
        const href = el$.is('a') ? el$.attr('href') : el$.find('a').first().attr('href');
        if (!name || !href) return;
        events.push({
          name,
          startDate: dateText || null,
          description: null,
          url: new URL(href, P1_URL).toString(),
          image: null,
          locationName: 'P1',
          address: P1_ADDRESS,
          organizer: 'P1',
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

      const eventUrl = ev.url ?? P1_URL;
      const sourceId = `p1-${Buffer.from(String(eventUrl)).toString('base64').slice(0, 20)}`;
      const coords = await getCoordinates(supabase, 'P1', P1_ADDRESS, 'München');

      collected.push({
        source_id: sourceId,
        title: ev.name,
        description: ev.description,
        category: 'Clubs',
        subcategory: null,
        start_date,
        start_time,
        location_name: 'P1',
        address: P1_ADDRESS,
        city: 'München',
        organizer: ev.organizer ?? 'P1',
        source_url: eventUrl,
        image_url: ev.image,
        latitude: coords?.latitude ?? null,
        longitude: coords?.longitude ?? null,
      });
    }
  } catch (err) {
    console.warn('[p1] error', err);
  }

  if (collected.length === 0) { console.log('[p1] no events parsed'); return; }
  console.log('[p1] upserting', collected.length, 'events');
  const { error } = await supabase.from('events').upsert(collected, { onConflict: 'source_id' });
  if (error) console.error('[p1] upsert error', error);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

export default run;
