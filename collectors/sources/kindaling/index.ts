import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { getCoordinates } from '../../core/geocode';
import { buildStableSourceId, dedupeBySourceId } from '../../core/scrape';

// kindaling.de: Plattform für Kinderkurse/Ferienprogramme/Familien-Events,
// deckt eine Nische ab, die weder eventim/muenchenticket/backstage noch das
// Stadtportal/meinestadt in der Tiefe abdecken (kleine Anbieter, Workshops,
// wiederkehrende Flohmärkte). robots.txt (per Direktabruf verifiziert,
// 2026-08) erlaubt /veranstaltungen/muenchen inkl. Pagination über ?page=N
// explizit (nur /activities, /aktivitäten/*, ?q=, ?view=map/block u.ä. sind
// gesperrt).
//
// Die Listing-Seite liefert nur eine ID-Liste (schema.org ItemList mit
// Detail-URLs), keine Termine direkt — Termine stecken erst auf den
// Einzelseiten (schema.org Event, teils mit "eventSchedule" für
// wiederkehrende Termine wie Wochenmärkte/Dauerausstellungen: ein
// Gesamtzeitraum in startDate/endDate plus ein wöchentliches Muster in
// eventSchedule.byDay). Erfordert deshalb 1 Request pro Event zusätzlich
// zu den Listing-Seiten — teurer als die Kategorie-Batch-Collectoren, aber
// die einzige Möglichkeit, an echte Termine zu kommen.
const LIST_URL = 'https://www.kindaling.de/veranstaltungen/muenchen';
const MAX_LIST_PAGES = 6;
const MAX_EVENT_DETAIL_ERRORS_PER_PAGE = 5;
const HORIZON_DAYS = 30;
const MIN_REQUEST_SPACING_MS = 1500;
const MAX_REQUEST_SPACING_MS = 3000;

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
};

// Kategorie wird aus dem ersten URL-Pfadsegment abgeleitet (Listing-Seite
// selbst liefert keine Kategorie-Info pro Item) — per Direktabruf über
// mehrere Seiten gesammelte Segmente, mit "Familie & Kinder" als Fallback
// für unbekannte/neue Segmente, da die gesamte Quelle familienorientiert ist.
const CATEGORY_BY_SEGMENT: Record<string, string> = {
  flohmaerkte: 'Märkte',
  maerkte: 'Märkte',
  kreatives: 'Workshops',
  'ki-coding-computer': 'Workshops',
  'kindertheater-shows': 'Familie & Kinder',
  kino: 'Kultur',
  feste: 'Feiern',
  sport: 'Sport',
  'sonstige-veranstaltungen': 'Familie & Kinder',
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

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function categoryFromUrl(url: string): string {
  try {
    const segment = new URL(url).pathname.split('/').filter(Boolean)[0] ?? '';
    return CATEGORY_BY_SEGMENT[segment] ?? 'Familie & Kinder';
  } catch {
    return 'Familie & Kinder';
  }
}

const WEEKDAY_FROM_SCHEMA: Record<string, number> = {
  Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6,
};

interface RawEventNode {
  name?: string;
  description?: string;
  startDate?: string;
  endDate?: string;
  eventSchedule?: { repeatFrequency?: string; byDay?: string[]; startTime?: string; endTime?: string }[];
  location?: { name?: string; address?: { streetAddress?: string; addressLocality?: string; postalCode?: string } };
  organizer?: { name?: string };
  image?: string[] | string;
  offers?: { price?: string | number; priceCurrency?: string; availability?: string }[] | { price?: string | number; priceCurrency?: string; availability?: string };
}

function findEventNode(html: string): RawEventNode | null {
  const scriptRe = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  let match: RegExpExecArray | null;
  while ((match = scriptRe.exec(html)) !== null) {
    try {
      const json = JSON.parse(match[1]);
      const graph = Array.isArray(json['@graph']) ? json['@graph'] : [json];
      const found = graph.find((node: any) => node && node['@type'] === 'Event');
      if (found) return found as RawEventNode;
    } catch {
      // ignore malformed blocks
    }
  }
  return null;
}

function priceInfoFromOffers(offers: RawEventNode['offers']): string | null {
  if (!offers) return null;
  const list = Array.isArray(offers) ? offers : [offers];
  const prices = list
    .map((o) => (o?.price !== undefined && o?.price !== null && o?.price !== '' ? Number(o.price) : null))
    .filter((p): p is number => p !== null && !isNaN(p));
  if (prices.length === 0) return null;
  if (prices.every((p) => p === 0)) return 'Kostenlos';
  const min = Math.min(...prices);
  return prices.length > 1 ? `ab ${min} EUR` : `${min} EUR`;
}

function addressToString(address: RawEventNode['location'] extends infer L ? (L extends { address?: infer A } ? A : never) : never): string | null {
  if (!address) return null;
  return [address.streetAddress, address.addressLocality, address.postalCode].filter(Boolean).join(', ') || null;
}

interface Occurrence {
  date: string;
  time: string | null;
}

// Erzeugt konkrete Termine im Horizont [heute, heute+HORIZON_DAYS) aus
// entweder einem einzelnen startDate/endDate ODER einem wöchentlichen
// eventSchedule-Muster (repeatFrequency "P1W" + byDay), begrenzt auf den
// Gesamtzeitraum der Reihe (node.startDate/endDate, oft mehrjährig, z.B.
// ein Flohmarkt der seit 2022 wöchentlich läuft).
function expandOccurrences(node: RawEventNode, today: Date): Occurrence[] {
  const horizonEnd = addDays(today, HORIZON_DAYS - 1);
  const todayStr = isoDate(today);

  if (node.eventSchedule && node.eventSchedule.length > 0) {
    const seriesStart = node.startDate ? node.startDate.slice(0, 10) : null;
    const seriesEnd = node.endDate ? node.endDate.slice(0, 10) : null;
    const occurrences: Occurrence[] = [];
    for (const schedule of node.eventSchedule) {
      if (schedule.repeatFrequency !== 'P1W' || !schedule.byDay) continue;
      const weekdays = schedule.byDay
        .map((d) => WEEKDAY_FROM_SCHEMA[d.split('/').pop() ?? ''])
        .filter((d): d is number => d !== undefined);
      for (let cursor = new Date(today); cursor <= horizonEnd; cursor = addDays(cursor, 1)) {
        const dateStr = isoDate(cursor);
        if (dateStr < todayStr) continue;
        if (seriesStart && dateStr < seriesStart) continue;
        if (seriesEnd && dateStr > seriesEnd) continue;
        if (!weekdays.includes(cursor.getUTCDay())) continue;
        occurrences.push({ date: dateStr, time: schedule.startTime ?? null });
      }
    }
    return occurrences;
  }

  if (!node.startDate) return [];
  const startDate = node.startDate.slice(0, 10);
  if (startDate < todayStr) return [];
  const startTimeMatch = node.startDate.match(/T(\d{2}:\d{2})/);
  return [{ date: startDate, time: startTimeMatch ? startTimeMatch[1] : null }];
}

export async function run() {
  console.log('[kindaling] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[kindaling] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const today = new Date(isoDate(new Date()));
  const detailUrls: string[] = [];
  const seenUrls = new Set<string>();

  for (let page = 1; page <= MAX_LIST_PAGES; page++) {
    try {
      const res = await fetch(`${LIST_URL}?page=${page}`, { headers: BROWSER_HEADERS });
      await wait(requestSpacingMs());
      if (!res.ok) { console.warn('[kindaling] list page failed', page, res.status); break; }
      const html = await res.text();
      const scriptRe = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
      let match: RegExpExecArray | null;
      let urls: string[] = [];
      while ((match = scriptRe.exec(html)) !== null) {
        try {
          const json = JSON.parse(match[1]);
          const itemList = Array.isArray(json['@graph']) ? json['@graph'].find((n: any) => n['@type'] === 'ItemList') : null;
          if (itemList) urls = itemList.itemListElement.map((i: any) => i.url).filter(Boolean);
        } catch {
          // ignore malformed blocks
        }
      }
      if (urls.length === 0) { console.log('[kindaling] no more list items at page', page); break; }
      for (const url of urls) {
        if (!seenUrls.has(url)) { seenUrls.add(url); detailUrls.push(url); }
      }
    } catch (err) {
      console.warn('[kindaling] list page error', page, err);
      break;
    }
  }
  console.log('[kindaling] found', detailUrls.length, 'detail URLs across', MAX_LIST_PAGES, 'pages');

  const collected: any[] = [];
  let detailErrors = 0;

  for (const url of detailUrls) {
    try {
      const res = await fetch(url, { headers: BROWSER_HEADERS });
      await wait(requestSpacingMs());
      if (!res.ok) { detailErrors++; continue; }
      const html = await res.text();
      const node = findEventNode(html);
      if (!node || !node.name) continue;

      const address = addressToString(node.location?.address);
      // Nicht-Münchner Umland-Events überspringen statt zu raten, analog
      // zum meinestadt-Collector — kindaling deckt auch Orte wie
      // "Markt Schwaben" oder "Oberschleißheim" ab.
      if (!address || !address.includes('München')) continue;

      const occurrences = expandOccurrences(node, today);
      if (occurrences.length === 0) continue;

      const priceInfo = priceInfoFromOffers(node.offers);
      const category = categoryFromUrl(url);
      const image = Array.isArray(node.image) ? node.image[0] : node.image ?? null;
      // location_name ist NOT NULL in der events-Tabelle — manche
      // kindaling-Locations liefern eine Adresse, aber keinen eigenen Namen
      // (per Direktabruf beobachtet), daher Fallback auf den Veranstalter
      // oder zuletzt schlicht "München".
      const locationName = node.location?.name ?? node.organizer?.name ?? 'München';
      const coords = await getCoordinates(supabase, locationName, address, 'München');

      for (const occ of occurrences) {
        collected.push({
          source_id: buildStableSourceId('kindaling', url, occ.date),
          title: node.name,
          description: node.description ?? null,
          category,
          subcategory: null,
          start_date: occ.date,
          start_time: occ.time,
          end_date: null,
          location_name: locationName,
          address,
          city: 'München',
          organizer: node.organizer?.name ?? null,
          source_url: url,
          image_url: image ?? null,
          price_info: priceInfo,
          sold_out: null,
          latitude: coords?.latitude ?? null,
          longitude: coords?.longitude ?? null,
        });
      }
    } catch (err) {
      detailErrors++;
      if (detailErrors <= MAX_EVENT_DETAIL_ERRORS_PER_PAGE) console.warn('[kindaling] detail error', url, err);
    }
  }

  console.log('[kindaling] parsed', collected.length, 'occurrences from', detailUrls.length, 'events,', detailErrors, 'detail errors');
  if (collected.length === 0) { console.log('[kindaling] no events parsed'); return; }
  console.log('[kindaling] upserting', collected.length, 'events');
  const { error } = await supabase.from('events').upsert(dedupeBySourceId(collected), { onConflict: 'source_id' });
  if (error) console.error('[kindaling] upsert error', error);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}

export default run;
