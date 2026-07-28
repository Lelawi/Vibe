import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { getCoordinates } from '../../core/geocode';

const IMPORT_EXPORT_URL = 'https://import-export.cc/';
const EVENT_LINK_SELECTOR = '.event.event-link.item > a.content';
const USER_AGENT = 'VibeApp-Collector/1.0';

export async function run() {
  console.log('[import-export] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.log('[import-export] missing supabase envs — skipping');
    return;
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const res = await fetch(IMPORT_EXPORT_URL, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) {
      console.error('[import-export] homepage fetch failed', res.status);
      return;
    }
    const html = await res.text();
    const $ = cheerio.load(html);
    const events: any[] = [];

    $(EVENT_LINK_SELECTOR).each((_, el) => {
      const anchor = $(el);
      const href = anchor.attr('href');
      const title = anchor.find('h2.io-title').text().trim();
      const dateText = anchor.find('button.system-color').text().trim();
      const kind = anchor.find('.event-infos p').last().text().trim();
      const img = anchor.find('img').attr('src') ?? null;

      if (!href || !title) return;

      const sourceUrl = href.startsWith('http') ? href : new URL(href, IMPORT_EXPORT_URL).toString();
      const sourceId = `import-export-${new URL(sourceUrl).pathname.split('/').filter(Boolean).pop()}`;
      const [weekday, ...dateParts] = dateText.split('.').map((part) => part.trim()).filter(Boolean);
      let start_date = null;
      let start_time = null;

      if (dateParts.length === 2) {
        const [day, month] = dateParts;
        const now = new Date();
        const year = now.getFullYear();
        const candidate = new Date(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T00:00:00`);
        if (!isNaN(candidate.getTime())) {
          if (candidate < now) {
            candidate.setFullYear(year + 1);
          }
          start_date = candidate.toISOString().slice(0, 10);
        }
      }

      events.push({
        source_id: sourceId,
        title,
        description: null,
        category: kind || 'Sonstiges',
        subcategory: null,
        start_date,
        start_time,
        location_name: 'Import Export München',
        address: 'Schwere-Reiter-Straße 2, 80637 München',
        city: 'München',
        organizer: 'Import Export München',
        source_url: sourceUrl,
        image_url: img,
        latitude: null,
        longitude: null,
      });
    });

    if (events.length === 0) {
      console.log('[import-export] no events found on homepage');
      return;
    }

    for (const event of events) {
      if (event.location_name) {
        const coords = await getCoordinates(supabase, event.location_name, event.address, 'München');
        event.latitude = coords?.latitude ?? null;
        event.longitude = coords?.longitude ?? null;
      }
    }

    const { error } = await supabase.from('events').upsert(events, { onConflict: 'source_id' });
    if (error) {
      console.error('[import-export] upsert error', error);
      return;
    }

    console.log('[import-export] upserted', events.length, 'events');
  } catch (err) {
    console.error('[import-export] error', err);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}

export default run;
