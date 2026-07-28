import { createClient } from '@supabase/supabase-js';
import { getCoordinates } from '../../core/geocode';
import { extractJsonLdEvents, extractDatedLinks, parseAbbrevEnglishDate, parseGermanDate } from '../../core/scrape';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { fileURLToPath } from 'url';

export async function run() {
  console.log('[eventfrog] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.log('[eventfrog] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — skipping');
    return;
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  // eventfrog.ch ist die Schweizer Plattform ohne München-Bezug; die deutsche
  // Instanz eventfrog.de listet die Münchner Veranstaltungen unter /muenchen.html
  const defaultUrls = ['https://www.eventfrog.de/de/events/muenchen.html'];
  const envUrls = process.env.EVENTFROG_SEARCH_URLS;
  const urls = envUrls ? envUrls.split(',').map((u) => u.trim()).filter(Boolean) : defaultUrls;

  const collected: any[] = [];
  const today = new Date().toISOString().slice(0, 10);

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

      // eventfrog.de rendert die Karten serverseitig ohne JSON-LD; als Fallback
      // werden Links mit erkennbarem Datum im Linktext ausgewertet (Format
      // z.B. "Jul 28" statt deutschem Datum).
      const events = extractJsonLdEvents($);
      if (!events.length) events.push(...extractDatedLinks($, url));

      for (const ev of events) {
        let start_date = null;
        let start_time = null;
        if (ev.startDate) {
          const d = new Date(ev.startDate);
          if (!isNaN(d.getTime())) {
            start_date = d.toISOString().slice(0, 10);
            start_time = d.toISOString().slice(11, 16);
          } else {
            start_date = parseAbbrevEnglishDate(ev.startDate) ?? parseGermanDate(ev.startDate);
          }
        }
        // Ohne Datum oder mit Datum in der Vergangenheit (z.B. Fehlparsen einer
        // zufälligen Zahlenfolge im Seitentext) wird das Event verworfen —
        // ein einzelner Ausreißer wie "2001-08-22" darf nicht den ganzen
        // Batch-Upsert wegen anderer Constraints zum Absturz bringen.
        if (!ev.name || !start_date || start_date < today) continue;

        const urlEvent = ev.url ?? url;
        const sourceId = `eventfrog-${Buffer.from(String(urlEvent)).toString('base64').slice(0, 20)}`;
        const locationName = ev.locationName ?? 'München';
        const coords = await getCoordinates(supabase, locationName, ev.address, 'München');

        collected.push({
          source_id: sourceId,
          title: ev.name ?? 'Unbenannt',
          description: ev.description,
          category: 'Sonstiges',
          subcategory: null,
          start_date,
          start_time,
          location_name: locationName,
          address: ev.address,
          city: 'München',
          organizer: ev.organizer,
          source_url: urlEvent,
          image_url: ev.image,
          price_info: ev.priceInfo,
          sold_out: ev.soldOut,
          latitude: coords?.latitude ?? null,
          longitude: coords?.longitude ?? null,
        });
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

export default run;
