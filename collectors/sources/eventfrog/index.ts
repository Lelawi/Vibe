import { createClient } from '@supabase/supabase-js';
import { getCoordinates } from '../../core/geocode';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { fileURLToPath } from 'url';

/**
 * Eventfrog collector (template)
 * - Implement scraping responsibly; check robots.txt and TOS.
 * - No API key required for placeholder mode.
 */

export async function run() {
  console.log('[eventfrog] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.log('[eventfrog] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — skipping');
    return;
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  // Configurable list of search/listing pages to try (comma-separated ENVs allowed)
  const defaultUrls = [
    'https://eventfrog.ch/de/events?search=M%C3%BCnchen',
    'https://eventfrog.ch/de/events?search=Munich',
  ];
  const envUrls = process.env.EVENTFROG_SEARCH_URLS;
  const urls = envUrls ? envUrls.split(',').map((u) => u.trim()).filter(Boolean) : defaultUrls;

  const collected: any[] = [];

  for (const url of urls) {
    try {
      console.log('[eventfrog] fetching', url);
      const res = await fetch(url, { headers: { 'User-Agent': 'VibeApp-Collector/1.0' } });
      if (!res.ok) {
        console.warn('[eventfrog] fetch failed', res.status, url);
        continue;
      }

      const html = await res.text();
      const $ = cheerio.load(html);

      // Prefer structured data (JSON-LD)
      const scripts = $('script[type="application/ld+json"]')
        .toArray()
        .map((el) => $(el).html())
        .filter(Boolean);

      for (const s of scripts) {
        try {
          const doc = JSON.parse(s!);
          // Event or EventList
          const items: any[] = [];
          if (doc['@type'] === 'Event') items.push(doc);
          if (doc['@type'] === 'ItemList' && Array.isArray(doc.itemListElement)) {
            for (const it of doc.itemListElement) {
              if (it && it['@type'] === 'ListItem' && it.item) items.push(it.item);
            }
          }
          if (Array.isArray(doc['@graph'])) {
            for (const node of doc['@graph']) if (node['@type'] === 'Event') items.push(node);
          }

          for (const ev of items) {
            const name = ev.name ?? ev['@id'] ?? null;
            const start = ev.startDate ?? ev.startDate;
            const description = ev.description ?? null;
            const urlEvent = ev.url ?? ev['@id'] ?? url;
            const image = ev.image?.url ?? (Array.isArray(ev.image) ? ev.image[0] : ev.image) ?? null;
            const location = ev.location ?? null;

            let location_name = null;
            let address = null;
            if (location) {
              if (typeof location === 'string') location_name = location;
              else {
                location_name = location.name ?? null;
                if (location.address) {
                  const a = location.address;
                  address = [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode]
                    .filter(Boolean)
                    .join(', ');
                }
              }
            }

            let start_date = null;
            let start_time = null;
            if (start) {
              const d = new Date(start);
              if (!isNaN(d.getTime())) {
                start_date = d.toISOString().slice(0, 10);
                start_time = d.toISOString().slice(11, 16);
              }
            }

            const sourceId = `eventfrog-${Buffer.from(String(urlEvent)).toString('base64').slice(0, 20)}`;

            const coords = await getCoordinates(supabase, location_name ?? name ?? 'Event', address, 'München');

            collected.push({
              source_id: sourceId,
              title: name ?? 'Unbenannt',
              description,
              category: ev.eventType ?? 'Sonstiges',
              subcategory: null,
              start_date,
              start_time,
              location_name,
              address,
              city: 'München',
              organizer: ev.organizer?.name ?? null,
              source_url: urlEvent,
              image_url: image,
              latitude: coords?.latitude ?? null,
              longitude: coords?.longitude ?? null,
            });
          }
        } catch (e) {
          // ignore parse errors
        }
      }

      // small polite delay
      await new Promise((r) => setTimeout(r, 600));
    } catch (err) {
      console.warn('[eventfrog] error fetching', url, err);
    }
  }

  if (collected.length === 0) {
    console.log('[eventfrog] no events parsed');
    return;
  }

  console.log('[eventfrog] upserting', collected.length, 'events');
  const { error } = await supabase.from('events').upsert(collected, { onConflict: 'source_id' });
  if (error) console.error('[eventfrog] upsert error', error);
}

  if (process.argv[1] === fileURLToPath(import.meta.url)) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
