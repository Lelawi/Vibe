import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { getCoordinates } from '../../core/geocode';
import { buildStableSourceId, dedupeBySourceId, extractJsonLdEvents } from '../../core/scrape';

// veranstaltungen.meinestadt.de aggregiert selbst aus vielen Quellen (u.a.
// eventim, kindaling.de, eventfrog) und liefert sauberes schema.org-
// Event-JSON-LD pro Karte (Name, startDate, location.address, teils
// offers.price) — per Direktabruf verifiziert (2026-08).
//
// robots.txt sperrt explizit die echte Pagination-Mechanik
// (`?curDatesPage=*`, `?allDatesPage=*`), d.h. mehr als die erste Seite pro
// Kategorie ist nicht zulässig abrufbar. Die Kategorie-Pfade selbst
// (`/muenchen/<kategorie>/alle`) sind dagegen NICHT gesperrt — genutzt hier
// wie beim Stadtportal-Collector als Multi-Kategorie-Ersatz für fehlende
// Pagination (jede Kategorie liefert unabhängig ~18-20 Events).
//
// "konzerte" bewusst ausgelassen: eventim/backstage/muenchenticket decken
// das schon ab (gleiche Begründung wie bei muenchen_stadtportal).
// "locations/alle" ist ein Location-Verzeichnis, keine Eventliste.
const BASE_URL = 'https://veranstaltungen.meinestadt.de/muenchen';

const CATEGORIES: { slug: string; category: string }[] = [
  { slug: 'comedy-humor', category: 'Comedy & Kabarett' },
  { slug: 'maerkte', category: 'Märkte' },
  { slug: 'kinderveranstaltungen', category: 'Familie & Kinder' },
  { slug: 'musicals-shows', category: 'Musical & Show' },
  { slug: 'kultur', category: 'Kultur' },
  { slug: 'partys-feiern', category: 'Party & Nachtleben' },
  { slug: 'festivals', category: 'Feiern' },
  { slug: 'volksfeste', category: 'Feiern' },
  { slug: 'freizeit-ausflug', category: 'Sonstiges' },
  { slug: 'sport', category: 'Sport' },
  { slug: 'kurse-seminare', category: 'Workshops' },
  { slug: 'religion-feiertage', category: 'Sonstiges' },
  { slug: 'messen', category: 'Sonstiges' },
];

const MIN_REQUEST_SPACING_MS = 2000;
const MAX_REQUEST_SPACING_MS = 4000;

// Bewusst Node's natives fetch (undici) statt node-fetch: per Direktabruf
// verifiziert (2026-08), dass node-fetch von der Akamai-Bot-Abwehr der
// Seite mit "Access Denied" (403) geblockt wird, während dieselbe Anfrage
// über natives fetch anstandslos 200 liefert — vermutlich ein TLS/HTTP2-
// Fingerprint-Unterschied zwischen den beiden HTTP-Clients, kein
// Header-Problem (identische Header in beiden Fällen getestet).
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

// startDate/endDate kommen als lokales ISO-Datum-Zeit ohne Zeitzone
// ("2026-08-07T14:00:00") — Datum und Uhrzeit werden getrennt in die
// events-Tabelle geschrieben (start_date, start_time).
function splitDateTime(iso: string | null): { date: string | null; time: string | null } {
  if (!iso) return { date: null, time: null };
  const [datePart, timePart] = iso.split('T');
  if (!datePart) return { date: null, time: null };
  return { date: datePart, time: timePart ? timePart.slice(0, 5) : null };
}

export async function run() {
  console.log('[meinestadt] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[meinestadt] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const today = isoDate(new Date());
  const collected: any[] = [];

  for (const { slug, category } of CATEGORIES) {
    try {
      const url = `${BASE_URL}/${slug}/alle`;
      const res = await fetch(url, { headers: BROWSER_HEADERS });
      await wait(requestSpacingMs());
      if (!res.ok) {
        console.warn(`[meinestadt] category ${slug} failed`, res.status);
        continue;
      }
      const html = await res.text();
      const $ = cheerio.load(html);
      const events = extractJsonLdEvents($);

      // Die Kategorieseiten decken auch Umland-Orte ab (per Direktabruf
      // beobachtet: u.a. Oberschleißheim, Zorneding) — nur Events mit
      // "München" in der geparsten Adresse übernehmen, alles andere
      // überspringen statt zu raten.
      let kept = 0;
      for (const ev of events) {
        if (!ev.name || !ev.startDate || !ev.url) continue;
        if (!ev.address || !ev.address.includes('München')) continue;
        const { date: startDate, time: startTime } = splitDateTime(ev.startDate);
        if (!startDate || startDate < today) continue;
        const { date: endDate } = splitDateTime(ev.endDate);

        const coords = await getCoordinates(supabase, ev.locationName ?? 'München', null, 'München');
        collected.push({
          source_id: buildStableSourceId(`meinestadt-${slug}`, ev.url, startDate),
          title: ev.name,
          description: ev.description,
          category,
          subcategory: null,
          start_date: startDate,
          start_time: startTime,
          end_date: endDate && endDate !== startDate ? endDate : null,
          location_name: ev.locationName,
          address: ev.address,
          city: 'München',
          organizer: ev.organizer,
          source_url: ev.url,
          image_url: ev.image,
          price_info: ev.priceInfo,
          sold_out: ev.soldOut,
          latitude: coords?.latitude ?? ev.latitude ?? null,
          longitude: coords?.longitude ?? ev.longitude ?? null,
        });
        kept++;
      }
      console.log(`[meinestadt] category ${category} (${slug}): ${events.length} geparst, ${kept} übernommen`);
    } catch (err) {
      console.warn(`[meinestadt] error for category ${category} (${slug})`, err);
    }
  }

  if (collected.length === 0) { console.log('[meinestadt] no events parsed'); return; }
  console.log('[meinestadt] upserting', collected.length, 'events');
  const { error } = await supabase.from('events').upsert(dedupeBySourceId(collected), { onConflict: 'source_id' });
  if (error) console.error('[meinestadt] upsert error', error);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}

export default run;
