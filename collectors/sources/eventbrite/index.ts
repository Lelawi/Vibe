import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { getCoordinates } from '../../core/geocode';
import { buildStableSourceId, dedupeBySourceId, extractJsonLdEvents } from '../../core/scrape';

// eventbrite.de -- die offizielle Event-Search-API wurde von Eventbrite im
// Februar 2020 für Drittanbieter komplett abgeschaltet (bewusste
// Geschäftsentscheidung, um genau diese Art von Aggregation zu verhindern).
// Übrig bleiben nur Endpunkte für "eigene Events als Organizer" -- für Vibe
// nutzlos, siehe collect-all.ts-Kommentar zum bisherigen Ausschluss.
//
// Die öffentlichen Such-/Browse-Seiten (/d/germany--munich/...) liefern
// stattdessen echte schema.org-Event-JSON-LD (inkl. Adresse UND geo-
// Koordinaten direkt, kein Nominatim-Fallback nötig) direkt im Server-HTML
// -- per Direktabruf verifiziert, 2026-08. robots.txt sperrt diese Pfade
// nicht (nur /api/v3/destination/events/ u.ä. -- die interne API hinter dem
// "mehr laden"/Infinite-Scroll, siehe unten). Damit strukturell dieselbe
// Situation wie meinestadt/kindaling (öffentliche, nicht gesperrte
// HTML-Seiten mit strukturierten Daten statt einer offiziellen API).
//
// ?page=2 etc. wird von der Basis-Listing-Seite ignoriert (liefert exakt
// dieselben ~56 Events wie page=1, per Direktabruf verifiziert) -- die
// echte Pagination läuft über eine interne API
// (/api/v3/destination/events/), die robots.txt explizit sperrt. Statt
// dessen wie bei meinestadt über mehrere Kategorie-Pfade abgedeckt, die
// serverseitig jeweils eine EIGENE erste Seite mit größtenteils
// unterschiedlichen Events liefern (per Direktabruf verifiziert: nur
// geringe Überschneidung zwischen den Kategorien und der Basis-Liste).
//
// Kategorie-Auswahl bewusst auf für Vibes Zielgruppe relevante Themen
// begrenzt (nicht Eventbrites volle ~20-Kategorien-Taxonomie) -- "business",
// "government", "religion-and-spirituality", "school-activities" etc.
// bewusst ausgelassen, gleiche Kuratierungslogik wie bei meinestadt.
// "community" ist trotz offizieller Taxonomie-Nennung ein 404 auf
// eventbrite.de (Stand 2026-08), daher nicht enthalten.
const BASE_URL = 'https://www.eventbrite.de/d/germany--munich';

const CATEGORIES: { slug: string; category: string }[] = [
  { slug: 'music', category: 'Konzerte' },
  { slug: 'food-and-drink', category: 'Sonstiges' },
  { slug: 'performing-and-visual-arts', category: 'Kultur' },
  { slug: 'hobbies', category: 'Workshops' },
  { slug: 'health', category: 'Workshops' },
  { slug: 'family-and-education', category: 'Familie & Kinder' },
  { slug: 'charity-and-causes', category: 'Sonstiges' },
  { slug: 'sports-and-fitness', category: 'Sport' },
];

const MIN_REQUEST_SPACING_MS = 2000;
const MAX_REQUEST_SPACING_MS = 4000;

// Natives fetch statt node-fetch (gleiche Begründung wie sources/meinestadt):
// große kommerzielle Plattformen mit Bot-Abwehr blocken node-fetch teils an
// dessen TLS/HTTP2-Fingerprint, während natives fetch (undici) durchkommt.
// Bei Eventbrite noch nicht im Produktionslauf (GitHub Actions) verifiziert
// -- vorsorglich gleich mit nativem fetch begonnen statt es erst bei einem
// 403 nachzuziehen.
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
};

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestSpacingMs(): number {
  return Math.floor(
    MIN_REQUEST_SPACING_MS + Math.random() * (MAX_REQUEST_SPACING_MS - MIN_REQUEST_SPACING_MS + 1)
  );
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// startDate/endDate kommen bei Eventbrite als volles ISO-Datum inkl.
// Zeitzonen-Offset ("2026-08-08T22:00:00+02:00") -- Datum und Uhrzeit werden
// getrennt in die events-Tabelle geschrieben (start_date, start_time).
function splitDateTime(iso: string | null): { date: string | null; time: string | null } {
  if (!iso) return { date: null, time: null };
  const [datePart, timePart] = iso.split('T');
  if (!datePart) return { date: null, time: null };
  return { date: datePart, time: timePart ? timePart.slice(0, 5) : null };
}

export async function run() {
  console.log('[eventbrite] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[eventbrite] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const today = isoDate(new Date());
  const collected: any[] = [];
  const seenUrls = new Set<string>();

  for (const { slug, category } of CATEGORIES) {
    try {
      const url = `${BASE_URL}/${slug}--events/`;
      const res = await fetch(url, { headers: BROWSER_HEADERS });
      await wait(requestSpacingMs());
      if (!res.ok) {
        console.warn(`[eventbrite] category ${slug} failed`, res.status);
        continue;
      }
      const html = await res.text();
      const $ = cheerio.load(html);
      const events = extractJsonLdEvents($);

      let kept = 0;
      for (const ev of events) {
        if (!ev.name || !ev.startDate || !ev.url) continue;
        // Die "germany--munich"-Destination deckt auch nahegelegene Orte ab
        // (per Direktabruf beobachtet) -- nur Events mit "München" in der
        // geparsten Adresse übernehmen, gleiches Muster wie meinestadt.
        if (!ev.address || !ev.address.includes('München')) continue;
        // Kategorie-Seiten überschneiden sich (ein Event kann in mehreren
        // Kategorien auftauchen) -- pro Lauf jede URL nur einmal übernehmen,
        // die zuerst gesehene Kategorie gewinnt.
        if (seenUrls.has(ev.url)) continue;
        seenUrls.add(ev.url);

        const { date: startDate, time: startTime } = splitDateTime(ev.startDate);
        if (!startDate || startDate < today) continue;
        const { date: endDate } = splitDateTime(ev.endDate);

        // Eventbrite liefert geo-Koordinaten direkt im JSON-LD (anders als
        // die meisten anderen Quellen) -- Nominatim nur als Fallback, wenn
        // sie ausnahmsweise fehlen, spart den Rate-Limit-Umweg im Regelfall.
        const coords = ev.latitude != null && ev.longitude != null
          ? { latitude: ev.latitude, longitude: ev.longitude }
          : await getCoordinates(supabase, ev.locationName ?? 'München', ev.address, 'München');

        collected.push({
          source_id: buildStableSourceId(`eventbrite-${slug}`, ev.url, startDate),
          title: ev.name,
          description: ev.description,
          category,
          subcategory: null,
          start_date: startDate,
          start_time: startTime,
          end_date: endDate && endDate !== startDate ? endDate : null,
          location_name: ev.locationName ?? 'München',
          address: ev.address,
          city: 'München',
          organizer: ev.organizer,
          source_url: ev.url,
          image_url: ev.image,
          price_info: ev.priceInfo,
          sold_out: ev.soldOut,
          latitude: coords?.latitude ?? null,
          longitude: coords?.longitude ?? null,
        });
        kept++;
      }
      console.log(`[eventbrite] category ${category} (${slug}): ${events.length} geparst, ${kept} übernommen`);
    } catch (err) {
      console.warn(`[eventbrite] error for category ${category} (${slug})`, err);
    }
  }

  if (collected.length === 0) { console.log('[eventbrite] no events parsed'); return; }

  // Preise stehen nicht im Listing-JSON-LD (siehe Kommentar oben), nur auf
  // der Detailseite jedes einzelnen Events — dort als eigener Event-Knoten
  // vom Subtyp z.B. "SocialEvent" (von isEventType()/extractJsonLdEvents
  // bereits erkannt, siehe core/scrape.ts) mit "offers" als AggregateOffer
  // (lowPrice/highPrice statt price — dafür wurde offersToPriceInfo()
  // erweitert). 1 zusätzlicher Request pro Event, gleiches Muster/gleicher
  // Tradeoff wie bei sources/kindaling/index.ts.
  let pricesFound = 0;
  for (const event of collected) {
    try {
      const res = await fetch(event.source_url, { headers: BROWSER_HEADERS });
      await wait(requestSpacingMs());
      if (!res.ok) continue;
      const html = await res.text();
      const $ = cheerio.load(html);
      const [detail] = extractJsonLdEvents($);
      if (detail?.priceInfo) {
        event.price_info = detail.priceInfo;
        pricesFound++;
      }
      if (detail?.soldOut != null) event.sold_out = detail.soldOut;
    } catch (err) {
      console.warn(`[eventbrite] price fetch failed for ${event.source_url}`, err);
    }
  }
  console.log(`[eventbrite] prices found for ${pricesFound}/${collected.length} events`);

  console.log('[eventbrite] upserting', collected.length, 'events');
  const { error } = await supabase.from('events').upsert(dedupeBySourceId(collected), { onConflict: 'source_id' });
  if (error) console.error('[eventbrite] upsert error', error);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}

export default run;
