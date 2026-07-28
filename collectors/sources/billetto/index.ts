import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { getCoordinates } from '../../core/geocode';
import { extractJsonLdEvents } from '../../core/scrape';

export async function run() {
  console.log('[billetto] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[billetto] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  // billetto.co.uk ist der britische Marktplatz ohne München-Bezug; die
  // deutsche/europäische Instanz billetto.eu hat eine eigene München-Stadtseite
  const urls = process.env.BILLETTO_SEARCH_URLS ? process.env.BILLETTO_SEARCH_URLS.split(',').map(s=>s.trim()).filter(Boolean) : [
    'https://billetto.eu/en/c/munchen-l',
  ];

  const collected: any[] = [];
  const today = new Date().toISOString().slice(0, 10);
  for (const url of urls) {
    try {
      console.log('[billetto] fetching', url);
      const res = await fetch(url, { headers: { 'User-Agent': 'VibeApp-Collector/1.0' } });
      if (!res.ok) { console.warn('[billetto] fetch failed', res.status); continue; }
      const html = await res.text();
      const $ = cheerio.load(html);

      const events = extractJsonLdEvents($);
      for (const ev of events) {
        let start_date = null, start_time = null;
        if (ev.startDate) {
          const d = new Date(ev.startDate);
          if (!isNaN(d.getTime())) { start_date = d.toISOString().slice(0,10); start_time = d.toISOString().slice(11,16); }
        }
        if (!start_date || start_date < today) continue;

        const eventUrl = ev.url ?? url;
        const sourceId = `billetto-${Buffer.from(String(eventUrl)).toString('base64').slice(0,20)}`;
        const locationName = ev.locationName ?? 'München';
        const coords = await getCoordinates(supabase, locationName, ev.address, 'München');

        collected.push({ source_id: sourceId, title: ev.name ?? 'Unbenannt', description: ev.description, category: 'Sonstiges', subcategory: null, start_date, start_time, location_name: locationName, address: ev.address, city: 'München', organizer: ev.organizer, source_url: eventUrl, image_url: ev.image, price_info: ev.priceInfo, sold_out: ev.soldOut, latitude: coords?.latitude ?? null, longitude: coords?.longitude ?? null });
      }

      await new Promise(r=>setTimeout(r,600));
    } catch (err) { console.warn('[billetto] error', err); }
  }

  if (!collected.length) { console.log('[billetto] no events parsed'); return; }
  console.log('[billetto] upserting', collected.length);
  const { error } = await supabase.from('events').upsert(collected, { onConflict: 'source_id' });
  if (error) console.error('[billetto] upsert error', error);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run().then(()=>process.exit(0)).catch((e)=>{ console.error(e); process.exit(1); });

export default run;
