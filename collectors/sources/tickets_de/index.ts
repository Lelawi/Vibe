import fetch from 'node-fetch';
import cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import { getCoordinates } from '../../core/geocode';

export async function run() {
  console.log('[tickets-de] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[tickets-de] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const urls = process.env.TICKETS_DE_SEARCH_URLS ? process.env.TICKETS_DE_SEARCH_URLS.split(',').map(s=>s.trim()).filter(Boolean) : [
    'https://www.tickets.de/search?q=Munich',
  ];

  const collected: any[] = [];
  for (const url of urls) {
    try {
      console.log('[tickets-de] fetching', url);
      const res = await fetch(url, { headers: { 'User-Agent': 'VibeApp-Collector/1.0' } });
      if (!res.ok) { console.warn('[tickets-de] fetch failed', res.status); continue; }
      const html = await res.text();
      const $ = cheerio.load(html);

      const scripts = $('script[type="application/ld+json"]').toArray().map(el=>$(el).html()).filter(Boolean);
      for (const s of scripts) {
        try {
          const doc = JSON.parse(s!);
          if (doc['@type'] === 'Event') {
            const ev = doc;
            const name = ev.name ?? null;
            const start = ev.startDate ?? null;
            const location = ev.location ?? null;

            let location_name = null;
            let address = null;
            if (location) {
              location_name = typeof location === 'string' ? location : location.name ?? null;
              if (location.address) {
                const a = location.address;
                address = [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode].filter(Boolean).join(', ');
              }
            }

            let start_date = null, start_time = null;
            if (start) {
              const d = new Date(start);
              if (!isNaN(d.getTime())) { start_date = d.toISOString().slice(0,10); start_time = d.toISOString().slice(11,16); }
            }

            const sourceId = `tickets-de-${Buffer.from(String(ev.url ?? name ?? Math.random())).toString('base64').slice(0,20)}`;
            const coords = await getCoordinates(supabase, location_name ?? name ?? 'Event', address, 'München');

            collected.push({
              source_id: sourceId,
              title: name ?? 'Unbenannt',
              description: ev.description ?? null,
              category: ev.eventType ?? 'Sonstiges',
              subcategory: null,
              start_date,
              start_time,
              location_name,
              address,
              city: 'München',
              organizer: ev.organizer?.name ?? null,
              source_url: ev.url ?? url,
              image_url: Array.isArray(ev.image)?ev.image[0]:ev.image ?? null,
              latitude: coords?.latitude ?? null,
              longitude: coords?.longitude ?? null,
            });
          }
        } catch (e) { /* ignore parse errors */ }
      }

      await new Promise(r=>setTimeout(r,600));
    } catch (err) { console.warn('[tickets-de] error', err); }
  }

  if (collected.length) { console.log('[tickets-de] upserting', collected.length); const { error } = await supabase.from('events').upsert(collected, { onConflict: 'source_id' }); if (error) console.error('[tickets-de] upsert error', error); }
}

if (require.main === module) run().then(()=>process.exit(0)).catch((e)=>{ console.error(e); process.exit(1); });
