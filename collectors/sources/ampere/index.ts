import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { getCoordinates } from '../../core/geocode';
import { extractJsonLdEvents, parseGermanDate } from '../../core/scrape';

// NICHT in collect-all.ts / im Workflow eingebunden: muffatwerk.de/de/pages/ampere
// lädt das Programm per JavaScript nach — im Server-HTML steht keine einzige
// Veranstaltung (verifiziert 2026-07). Bräuchte einen Headless-Browser statt
// fetch+cheerio. Der Ampere ist der kleinere Club-Saal im Muffatwerk und hat
// keine eigene Domain — das Programm läuft über muffatwerk.de.
const AMPERE_URL = 'https://www.muffatwerk.de/de/pages/ampere';
const AMPERE_ADDRESS = 'Zellstraße 4, 81667 München';

export async function run() {
  console.log('[ampere] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[ampere] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const collected: any[] = [];

  try {
    console.log('[ampere] fetching', AMPERE_URL);
    const res = await fetch(AMPERE_URL, { headers: { 'User-Agent': 'VibeApp-Collector/1.0' } });
    if (!res.ok) { console.warn('[ampere] fetch failed', res.status); return; }
    const html = await res.text();
    const $ = cheerio.load(html);

    const events = extractJsonLdEvents($);

    if (!events.length) {
      $('a[href*="/event"], article, .event, .teaser').each((_, el) => {
        const el$ = $(el);
        const name = el$.find('h1, h2, h3').first().text().trim();
        const dateText = el$.find('time').attr('datetime') || el$.find('time').text().trim();
        const href = el$.is('a') ? el$.attr('href') : el$.find('a').first().attr('href');
        if (!name || !href) return;
        events.push({
          name,
          startDate: dateText || null,
          description: null,
          url: new URL(href, AMPERE_URL).toString(),
          image: null,
          locationName: 'Ampere München',
          address: AMPERE_ADDRESS,
          organizer: 'Muffatwerk',
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

      const eventUrl = ev.url ?? AMPERE_URL;
      const sourceId = `ampere-${Buffer.from(String(eventUrl)).toString('base64').slice(0, 20)}`;
      const coords = await getCoordinates(supabase, 'Ampere München', AMPERE_ADDRESS, 'München');

      collected.push({
        source_id: sourceId,
        title: ev.name,
        description: ev.description,
        category: 'Konzerte',
        subcategory: null,
        start_date,
        start_time,
        location_name: 'Ampere München',
        address: AMPERE_ADDRESS,
        city: 'München',
        organizer: ev.organizer ?? 'Muffatwerk',
        source_url: eventUrl,
        image_url: ev.image,
        latitude: coords?.latitude ?? null,
        longitude: coords?.longitude ?? null,
      });
    }
  } catch (err) {
    console.warn('[ampere] error', err);
  }

  if (collected.length === 0) { console.log('[ampere] no events parsed'); return; }
  console.log('[ampere] upserting', collected.length, 'events');
  const { error } = await supabase.from('events').upsert(collected, { onConflict: 'source_id' });
  if (error) console.error('[ampere] upsert error', error);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

export default run;
