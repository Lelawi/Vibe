import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { extractJsonLdEvents } from '../../core/scrape';
import { getCoordinates } from '../../core/geocode';

// eintrittfrei-muenchen.de listet ausschließlich kostenlose Veranstaltungen
// in München (WordPress "The Events Calendar"-Plugin, Markup + JSON-LD per
// Direktabruf verifiziert, 2026-07). Jede Event-Karte trägt vollständige
// schema.org-Event-JSON-LD inkl. startDate, endDate (wichtig: einige
// Ausstellungen laufen über Monate, z.B. "startDate":"2025-05-15",
// "endDate":"2027-04-30") und location.geo (Koordinaten direkt von der
// Quelle — keine eigene Geokodierung nötig, Nominatim nur als Fallback
// falls geo mal fehlt). Da die Seite explizit nur Gratis-Events listet,
// wird price_info immer fest auf 'Kostenlos' gesetzt statt geraten.
const BASE_URL = 'https://www.eintrittfrei-muenchen.de/veranstaltungen/liste/';
const MAX_PAGES = 8;

function stripHtml(html: string | null): string | null {
  if (!html) return null;
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return text || null;
}

export async function run() {
  console.log('[eintrittfrei-muenchen] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[eintrittfrei-muenchen] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const collected: any[] = [];
  const seenUrls = new Set<string>();

  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = page === 1 ? BASE_URL : `${BASE_URL}seite/${page}/`;
      console.log('[eintrittfrei-muenchen] fetching', url);
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
      });
      if (!res.ok) { console.warn('[eintrittfrei-muenchen] fetch failed', url, res.status); break; }
      const html = await res.text();
      const $ = cheerio.load(html);
      const events = extractJsonLdEvents($);
      if (events.length === 0) { console.log('[eintrittfrei-muenchen] no more events, stopping at page', page); break; }

      for (const ev of events) {
        if (!ev.name || !ev.startDate || !ev.url) continue;
        if (seenUrls.has(ev.url)) continue;
        seenUrls.add(ev.url);

        const startDateObj = new Date(ev.startDate);
        if (isNaN(startDateObj.getTime())) continue;
        const start_date = startDateObj.toISOString().slice(0, 10);
        const start_time = ev.startDate.includes('T') ? startDateObj.toISOString().slice(11, 16) : null;

        let end_date: string | null = null;
        if (ev.endDate) {
          const endDateObj = new Date(ev.endDate);
          if (!isNaN(endDateObj.getTime())) {
            const candidateEnd = endDateObj.toISOString().slice(0, 10);
            if (candidateEnd !== start_date) end_date = candidateEnd;
          }
        }

        let latitude = ev.latitude;
        let longitude = ev.longitude;
        if ((latitude === null || longitude === null) && ev.locationName) {
          const coords = await getCoordinates(supabase, ev.locationName, ev.address, 'München');
          latitude = coords?.latitude ?? null;
          longitude = coords?.longitude ?? null;
        }

        const sourceId = `eintrittfrei-muenchen-${Buffer.from(ev.url).toString('base64').slice(0, 24)}`;
        collected.push({
          source_id: sourceId,
          title: ev.name,
          description: stripHtml(ev.description),
          category: 'Kultur',
          subcategory: null,
          start_date,
          start_time,
          end_date,
          location_name: ev.locationName,
          address: ev.address,
          city: 'München',
          organizer: ev.organizer,
          source_url: ev.url,
          image_url: ev.image,
          price_info: 'Kostenlos',
          latitude,
          longitude,
        });
      }

      if (page < MAX_PAGES) await new Promise((r) => setTimeout(r, 1000));
    }
  } catch (err) {
    console.warn('[eintrittfrei-muenchen] error', err);
  }

  if (collected.length === 0) { console.log('[eintrittfrei-muenchen] no events parsed'); return; }
  console.log('[eintrittfrei-muenchen] upserting', collected.length, 'events');
  const { error } = await supabase.from('events').upsert(collected, { onConflict: 'source_id' });
  if (error) console.error('[eintrittfrei-muenchen] upsert error', error);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

export default run;
