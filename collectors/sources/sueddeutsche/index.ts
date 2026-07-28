// NICHT in collect-all.ts / im Workflow eingebunden: die SZ-Thema-Seite listet
// Nachrichtenartikel über Veranstaltungen, keinen strukturierten Event-Kalender
// mit schema.org-Markup — als Eventquelle ungeeignet.
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { getCoordinates } from '../../core/geocode';

export async function run() {
  console.log('[sueddeutsche] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[sueddeutsche] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const urls = process.env.SUEDDEUTSCHE_SEARCH_URLS ? process.env.SUEDDEUTSCHE_SEARCH_URLS.split(',').map(s=>s.trim()).filter(Boolean) : [
    'https://www.sueddeutsche.de/thema/Veranstaltungen+M%C3%BCnchen',
  ];

  const collected: any[] = [];
  for (const url of urls) {
    try {
      console.log('[sueddeutsche] fetching', url);
      const res = await fetch(url, { headers: { 'User-Agent': 'VibeApp-Collector/1.0' } });
      if (!res.ok) { console.warn('[sueddeutsche] fetch failed', res.status); continue; }
      const html = await res.text();
      const $ = cheerio.load(html);

      const scripts = $('script[type="application/ld+json"]').toArray().map(el=>$(el).html()).filter(Boolean);
      for (const s of scripts) {
        try {
          const doc = JSON.parse(s!);
          // doc may be an Event, EventSeries or contain @graph
          const items: any[] = [];
          if (doc['@type'] === 'Event') items.push(doc);
          if (Array.isArray(doc['@graph'])) for (const node of doc['@graph']) if (node['@type'] === 'Event') items.push(node);

          for (const ev of items) {
            const name = ev.name ?? null;
            const start = ev.startDate ?? null;
            const location = ev.location ?? null;

            let location_name = null; let address = null;
            if (location) {
              location_name = typeof location === 'string' ? location : location.name ?? null;
              if (location.address) { const a = location.address; address = [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode].filter(Boolean).join(', '); }
            }

            let start_date=null, start_time=null;
            if (start) { const d=new Date(start); if (!isNaN(d.getTime())) { start_date=d.toISOString().slice(0,10); start_time=d.toISOString().slice(11,16); } }

            const sourceId = `sueddeutsche-${Buffer.from(String(ev.url ?? name ?? Math.random())).toString('base64').slice(0,20)}`;
            const coords = await getCoordinates(supabase, location_name ?? name ?? 'Event', address, 'München');

            collected.push({ source_id: sourceId, title: name ?? 'Unbenannt', description: ev.description ?? null, category: ev.eventType ?? 'Sonstiges', subcategory: null, start_date, start_time, location_name, address, city: 'München', organizer: ev.organizer?.name ?? null, source_url: ev.url ?? url, image_url: Array.isArray(ev.image)?ev.image[0]:ev.image ?? null, latitude: coords?.latitude ?? null, longitude: coords?.longitude ?? null });
          }
        } catch (e) { /* ignore */ }
      }

      await new Promise(r=>setTimeout(r,600));
    } catch (err) { console.warn('[sueddeutsche] error', err); }
  }

  if (collected.length) { console.log('[sueddeutsche] upserting', collected.length); const { error } = await supabase.from('events').upsert(collected, { onConflict: 'source_id' }); if (error) console.error('[sueddeutsche] upsert error', error); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run().then(()=>process.exit(0)).catch((e)=>{ console.error(e); process.exit(1); });

export default run;
