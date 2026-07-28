// NICHT in collect-all.ts / im Workflow eingebunden: der Kalender lädt seine
// Einträge per JavaScript/API nach — im Server-HTML steht keine einzige
// Veranstaltung (verifiziert 2026-07). Bräuchte einen Headless-Browser
// (Playwright/Puppeteer) statt fetch+cheerio, oder eine direkte API/ICS-Quelle.
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { getCoordinates } from '../../core/geocode';
import { extractJsonLdEvents, parseGermanDate } from '../../core/scrape';

const LMU_URL = 'https://www.lmu.de/de/newsroom/veranstaltungskalender/';

export async function run() {
  console.log('[lmu] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[lmu] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const collected: any[] = [];

  try {
    console.log('[lmu] fetching', LMU_URL);
    const res = await fetch(LMU_URL, { headers: { 'User-Agent': 'VibeApp-Collector/1.0' } });
    if (!res.ok) { console.warn('[lmu] fetch failed', res.status); return; }
    const html = await res.text();
    const $ = cheerio.load(html);

    const events = extractJsonLdEvents($);

    // Fallback: der Kalender listet Veranstaltungen typischerweise als
    // Karten/Links mit Titel + Datum, falls kein JSON-LD vorhanden ist.
    if (!events.length) {
      $('a[href*="/veranstaltung"], article, li.teaser').each((_, el) => {
        const el$ = $(el);
        const name = el$.find('h1, h2, h3').first().text().trim() || el$.text().trim().slice(0, 120);
        const dateText = el$.find('time').attr('datetime') || el$.find('time').text().trim() || el$.text();
        const href = el$.is('a') ? el$.attr('href') : el$.find('a').first().attr('href');
        if (!name || !href) return;
        events.push({
          name,
          startDate: dateText || null,
          description: null,
          url: new URL(href, LMU_URL).toString(),
          image: null,
          locationName: null,
          address: null,
          organizer: 'LMU München',
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

      const eventUrl = ev.url ?? LMU_URL;
      const sourceId = `lmu-${Buffer.from(String(eventUrl)).toString('base64').slice(0, 20)}`;
      const locationName = ev.locationName ?? 'LMU München';
      const coords = await getCoordinates(supabase, locationName, ev.address, 'München');

      collected.push({
        source_id: sourceId,
        title: ev.name,
        description: ev.description,
        category: 'Bildung',
        subcategory: null,
        start_date,
        start_time,
        location_name: locationName,
        address: ev.address,
        city: 'München',
        organizer: ev.organizer ?? 'LMU München',
        source_url: eventUrl,
        image_url: ev.image,
        latitude: coords?.latitude ?? null,
        longitude: coords?.longitude ?? null,
      });
    }
  } catch (err) {
    console.warn('[lmu] error', err);
  }

  if (collected.length === 0) { console.log('[lmu] no events parsed'); return; }
  console.log('[lmu] upserting', collected.length, 'events');
  const { error } = await supabase.from('events').upsert(collected, { onConflict: 'source_id' });
  if (error) console.error('[lmu] upsert error', error);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

export default run;
