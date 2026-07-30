import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { getCoordinates } from '../../core/geocode';
import { extractJsonLdEvents, extractJsonLdPricesByUrl, extractInMuenchenTeasers, parseGermanDate, checkInMuenchenFreeEntry, buildStableSourceId, dedupeBySourceId } from '../../core/scrape';

// Werkhaus hat keine eigene scrapbare Programmseite; die in-muenchen.de-
// Locationseite listet dieselben Termine serverseitig gerendert (2 Events
// bei Verifikation, Stand 2026-07 — kleine Location, entsprechend wenige
// Einträge). Keine gesicherte Adresse gefunden — Geokodierung läuft über
// den Venue-Namen.
const WERKHAUS_URL = 'https://www.in-muenchen.de/locations/werkhaus.html';

export async function run() {
  console.log('[werkhaus] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[werkhaus] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const collected: any[] = [];
  const today = new Date().toISOString().slice(0, 10);

  try {
    console.log('[werkhaus] fetching', WERKHAUS_URL);
    const res = await fetch(WERKHAUS_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) { console.warn('[werkhaus] fetch failed', res.status); return; }
    const html = await res.text();
    const $ = cheerio.load(html);

    // JSON-LD zeigt nur die nächsten ~25 Termine, aber mit echten Preisen;
    // die Teaser-Liste zeigt alle, aber nie einen Preis. Teaser bleiben die
    // primäre, vollständige Liste; JSON-LD wird nur zur Preis-Anreicherung
    // per URL-Abgleich genutzt (Fallback auf JSON-LD als Event-Liste nur,
    // falls die Teaser-Seite mal leer zurückkommt).
    const teaserEvents = extractInMuenchenTeasers($, WERKHAUS_URL);
    const priceByUrl = extractJsonLdPricesByUrl($);
    const events = teaserEvents.length ? teaserEvents : extractJsonLdEvents($);

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
          const timeMatch = ev.startDate.match(/(\d{1,2}):(\d{2})\s*Uhr/);
          if (timeMatch) start_time = `${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}`;
        }
      }
      if (!ev.name || !start_date || start_date < today) continue;

      const eventUrl = ev.url ?? WERKHAUS_URL;
      const sourceId = buildStableSourceId('werkhaus', String(eventUrl), start_date);
      const coords = await getCoordinates(supabase, 'Werkhaus', null, 'München');
      const price_info = priceByUrl.get(String(eventUrl)) ?? (await checkInMuenchenFreeEntry(eventUrl));

      collected.push({
        source_id: sourceId,
        title: ev.name,
        description: ev.description,
        category: 'Kultur',
        subcategory: null,
        start_date,
        start_time,
        location_name: 'Werkhaus',
        address: null,
        city: 'München',
        organizer: ev.organizer ?? 'Werkhaus',
        source_url: eventUrl,
        image_url: ev.image,
        price_info,
        latitude: coords?.latitude ?? null,
        longitude: coords?.longitude ?? null,
      });
    }
  } catch (err) {
    console.warn('[werkhaus] error', err);
  }

  if (collected.length === 0) { console.log('[werkhaus] no events parsed'); return; }
  console.log('[werkhaus] upserting', collected.length, 'events');
  const { error } = await supabase.from('events').upsert(dedupeBySourceId(collected), { onConflict: 'source_id' });
  if (error) console.error('[werkhaus] upsert error', error);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

export default run;
