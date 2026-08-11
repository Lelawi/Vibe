import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { getCoordinates } from '../../core/geocode';
import { extractJsonLdEvents, buildStableSourceId, dedupeBySourceId } from '../../core/scrape';

// lieberscholli.de selbst hat keine eigene Programmseite mehr — die komplette
// Terminliste läuft über ein eingebettetes Ticketshop-Widget auf einer
// eigenen Subdomain (cdn.ticket.io, data-tioservice="shop-legacy"), die
// server-seitig gerendertes JSON-LD pro Event liefert (Titel, Datum, Preis,
// Adresse, Geo-Koordinaten — vollständiger als die meisten anderen
// Single-Venue-Quellen hier). Per Direktabruf verifiziert (2026-08): 6
// anstehende MusicEvent-Einträge, robots.txt erlaubt uneingeschränkt.
const LIEBER_SCHOLLI_URL = 'https://lieberscholli.ticket.io/';
const LIEBER_SCHOLLI_ADDRESS = 'Landsberger Straße 212, 80687 München';

export async function run() {
  console.log('[lieber_scholli] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[lieber_scholli] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const collected: any[] = [];
  const today = new Date().toISOString().slice(0, 10);

  try {
    console.log('[lieber_scholli] fetching', LIEBER_SCHOLLI_URL);
    const res = await fetch(LIEBER_SCHOLLI_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) { console.warn('[lieber_scholli] fetch failed', res.status); return; }
    const html = await res.text();
    const $ = cheerio.load(html);
    const events = extractJsonLdEvents($);

    for (const ev of events) {
      if (!ev.name || !ev.startDate) continue;
      const d = new Date(ev.startDate);
      if (isNaN(d.getTime())) continue;
      const start_date = d.toISOString().slice(0, 10);
      const start_time = d.toISOString().slice(11, 16);
      if (start_date < today) continue;

      const eventUrl = ev.url ?? LIEBER_SCHOLLI_URL;
      const sourceId = buildStableSourceId('lieber-scholli', String(eventUrl), start_date);
      const coords = await getCoordinates(supabase, 'lieberscholli', LIEBER_SCHOLLI_ADDRESS, 'München');

      collected.push({
        source_id: sourceId,
        title: ev.name,
        description: ev.description && ev.description !== 'N/A' ? ev.description : null,
        category: 'Clubs',
        subcategory: null,
        start_date,
        start_time,
        location_name: 'lieberscholli',
        address: LIEBER_SCHOLLI_ADDRESS,
        city: 'München',
        organizer: 'lieberscholli',
        source_url: eventUrl,
        image_url: ev.image,
        price_info: ev.priceInfo,
        sold_out: ev.soldOut,
        latitude: coords?.latitude ?? ev.latitude ?? null,
        longitude: coords?.longitude ?? ev.longitude ?? null,
      });
    }
  } catch (err) {
    console.warn('[lieber_scholli] error', err);
  }

  if (collected.length === 0) { console.log('[lieber_scholli] no events parsed'); return; }
  console.log('[lieber_scholli] upserting', collected.length, 'events');
  const { error } = await supabase.from('events').upsert(dedupeBySourceId(collected), { onConflict: 'source_id' });
  if (error) console.error('[lieber_scholli] upsert error', error);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

export default run;
