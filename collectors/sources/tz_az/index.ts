import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { getCoordinates } from '../../core/geocode';

export async function run() {
  console.log('[tz-az] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[tz-az] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const urls = process.env.TZ_AZ_SEARCH_URLS ? process.env.TZ_AZ_SEARCH_URLS.split(',').map(s=>s.trim()).filter(Boolean) : [
    'https://www.tz.de/muenchen/veranstaltungen',
  ];

  const collected: any[] = [];
  for (const url of urls) {
    try {
      console.log('[tz-az] fetching', url);
      const res = await fetch(url, { headers: { 'User-Agent': 'VibeApp-Collector/1.0' } });
      if (!res.ok) { console.warn('[tz-az] fetch failed', res.status); continue; }
      const html = await res.text();
      const $ = cheerio.load(html);

      // Try JSON-LD first
      const scripts = $('script[type="application/ld+json"]').toArray().map(el=>$(el).html()).filter(Boolean);
      const events: any[] = [];
      for (const s of scripts) {
        try {
          const doc = JSON.parse(s!);
          if (doc['@type'] === 'Event') events.push(doc);
          if (Array.isArray(doc['@graph'])) for (const node of doc['@graph']) if (node['@type'] === 'Event') events.push(node);
        } catch (e) { /* ignore parse errors */ }
      }

      // Fallback: look for elements with itemtype Event
      if (!events.length) {
        $('[itemscope][itemtype*="Event"]').each((i, el) => {
          try {
            const item = {} as any;
            const el$ = $(el);
            item.name = el$.find('[itemprop="name"]').text().trim() || null;
            item.startDate = el$.find('[itemprop="startDate"]').attr('datetime') || el$.find('[itemprop="startDate"]').text().trim() || null;
            const loc = el$.find('[itemprop="location"]');
            if (loc && loc.length) {
              item.location = { name: loc.find('[itemprop="name"]').text().trim() || null };
              const addr = loc.find('[itemprop="address"]');
              if (addr && addr.length) {
                item.location.address = { streetAddress: addr.find('[itemprop="streetAddress"]').text().trim() || null, addressLocality: addr.find('[itemprop="addressLocality"]').text().trim() || null };
              }
            }
            if (item.name) events.push(item);
          } catch (e) { /* ignore */ }
        });
      }

      for (const ev of events) {
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

        const sourceId = `tz-az-${Buffer.from(String(ev.url ?? name ?? Math.random())).toString('base64').slice(0,20)}`;
        const coords = await getCoordinates(supabase, location_name ?? name ?? 'Event', address, 'München');

        collected.push({ source_id: sourceId, title: name ?? 'Unbenannt', description: ev.description ?? null, category: ev.eventType ?? 'Sonstiges', subcategory: null, start_date, start_time, location_name, address, city: 'München', organizer: ev.organizer?.name ?? null, source_url: ev.url ?? url, image_url: Array.isArray(ev.image)?ev.image[0]:ev.image ?? null, latitude: coords?.latitude ?? null, longitude: coords?.longitude ?? null });
      }

      await new Promise(r=>setTimeout(r,600));
    } catch (err) { console.warn('[tz-az] error', err); }
  }

  if (collected.length) { console.log('[tz-az] upserting', collected.length); const { error } = await supabase.from('events').upsert(collected, { onConflict: 'source_id' }); if (error) console.error('[tz-az] upsert error', error); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run().then(()=>process.exit(0)).catch((e)=>{ console.error(e); process.exit(1); });

export default run;
