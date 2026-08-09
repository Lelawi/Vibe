import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { getCoordinates } from '../../core/geocode';
import { buildStableSourceId, dedupeBySourceId } from '../../core/scrape';

// Das offizielle Stadtportal muenchen.de (NICHT zu verwechseln mit dem
// bereits genutzten privaten Magazin in-muenchen.de, siehe muenchen_de/
// p1/feierwerk etc.) betreibt unter /veranstaltungen/event/konzerte eine
// stadtweite, filterbare Veranstaltungsdatenbank mit echtem schema.org-
// Microdata im Server-HTML (itemprop="event"/"name"/"startDate"/...) — trotz
// des "konzerte" im URL-Pfad zeigt die Seite OHNE Kategorie-Filter faktisch
// alle Rubriken (verifiziert 2026-08: u.a. ein Kinder-Ausflugsprogramm ohne
// jeden Musikbezug erschien auf Seite 1). "konzerte" ist also nur der
// Einstiegspfad, nicht der Scope.
const BASE_URL = 'https://www.muenchen.de/veranstaltungen/event/konzerte';

// Bewusst nur Nicht-Musik-Rubriken (IDs aus dem "Kategorie"-Mehrfachauswahl-
// Feld der Seite, per Direktabruf ermittelt, 2026-08): Konzerte/Rock&Pop/
// HipHop/Electronic/Jazz/Klassik/Volksmusik werden hier ausgeklammert, weil
// eventim/backstage/muenchenticket diese bereits deutlich abdecken — das
// spart Requests und vermeidet unnötige Dubletten, statt eine kombinierte
// Mehrfachauswahl zu nutzen (die per Direktabruf mit `[]`-Query-Syntax 0
// Treffer lieferte, während dieselbe ID einzeln zuverlässig funktionierte —
// vermutlich ein serverseitiges Problem mit dem Mehrfachauswahl-Encoding,
// nicht mit den einzelnen IDs selbst).
const CATEGORIES: { id: string; category: string }[] = [
  { id: '27905', category: 'Theater' },
  { id: '28092', category: 'Comedy & Kabarett' },
  { id: '27883', category: 'Comedy & Kabarett' },
  { id: '27885', category: 'Ausstellungen' },
  { id: '27895', category: 'Familie & Kinder' },
  { id: '28105', category: 'Märkte' },
  { id: '28085', category: 'Märkte' },
  { id: '27888', category: 'Feiern' },
];

// 30 Tage statt eines größeren Horizonts wie bei eventim (180 Tage): die
// Seite deckt ALLE Münchner Rubriken gemeinsam ab (nicht nur Konzerte), ein
// einzelner 30-Tage-Testabruf ohne Kategorie-Filter lieferte bereits 40
// Seiten á 30 Events (~1200 Events). Pro Rubrik hier einzeln deutlich
// weniger, aber über 8 Rubriken hinweg summiert sich das — 30 Tage hält die
// Gesamt-Requestzahl im collect-all-Lauf in einem vertretbaren Rahmen.
const HORIZON_DAYS = 30;
const MAX_PAGES_PER_CATEGORY = 15;
const MIN_REQUEST_SPACING_MS = 2000;
const MAX_REQUEST_SPACING_MS = 4000;

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
  Referer: 'https://www.muenchen.de/veranstaltungen',
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

interface RawItem {
  title: string;
  startDate: string | null;
  endDate: string | null;
  startTime: string | null;
  locationName: string | null;
  ticketUrl: string | null;
}

// Markup per Direktabruf verifiziert (2026-08):
// <li class="m-listing__list-item">
//   <div class="m-event-list-item" itemprop="event" itemscope itemtype="https://schema.org/Event">
//     <time itemprop="startDate" datetime="2026-08-07T12:00:00Z">...
//     <time itemprop="endDate" datetime="2026-08-28T12:00:00Z">...
//     <h3 class="m-event-list-item__headline" itemprop="name"><span>Titel</span></h3>
//     <p class="m-event-list-item__detail"><time datetime="07.08.2026 - 08:30:00">...</time> - <time datetime="...17:00:00">...</time></p>
//     <p class="m-event-list-item__detail" itemprop="location">Ort</p>
//     <a class="m-button ..." href="https://...">Tickets</a>
// Die eigene "Kategorie"-Spalte im Markup ist auf jeder Seite leer (per
// Direktabruf verifiziert) — deshalb wird die Kategorie hier NICHT aus dem
// HTML gelesen, sondern kommt aus dem CATEGORIES-Eintrag, mit dem die
// jeweilige Seite angefragt wurde.
function parseListingPage($: cheerio.CheerioAPI): RawItem[] {
  const items: RawItem[] = [];

  $('.m-listing__list-item').each((_, el) => {
    const el$ = $(el);
    const title = el$.find('.m-event-list-item__headline').first().text().replace(/\s+/g, ' ').trim();
    const startDate = el$.find('time[itemprop="startDate"]').first().attr('datetime')?.slice(0, 10) ?? null;
    const endDate = el$.find('time[itemprop="endDate"]').first().attr('datetime')?.slice(0, 10) ?? null;

    // Die feinere Uhrzeit steckt in einem zweiten, separaten <time>-Paar im
    // Format "DD.MM.YYYY - HH:MM:SS" (kein ISO) — das grobe itemprop=startDate
    // hat nur Tagesgranularität (immer 12:00:00Z).
    const timeAttr = el$.find('.m-event-list-item__detail time').first().attr('datetime') ?? '';
    const timeMatch = timeAttr.match(/(\d{1,2}):(\d{2}):\d{2}\s*$/);
    const startTime = timeMatch ? `${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}` : null;

    const locationName = el$.find('.m-event-list-item__detail[itemprop="location"]').first().text().replace(/\s+/g, ' ').trim() || null;
    const ticketUrl = el$.find('.m-event-list-item__meta a[href]').first().attr('href') ?? null;

    if (title && startDate) items.push({ title, startDate, endDate, startTime, locationName, ticketUrl });
  });

  return items;
}

// Die muenchen.de-Listing-Karten selbst haben KEIN <img> im Markup (per
// Direktabruf verifiziert, 2026-08) — anders als die anderen Felder gibt es
// hier nichts zum Scrapen. Viele Ticket-Links zeigen aber direkt auf
// muenchenticket.de (siehe ticketUrl), das pro Event-Seite ein reales
// og:image liefert (per Nutzer-Beispiel verifiziert: "Putsch - Anleitung zur
// Zerstörung einer Demokratie"). Ein zusätzlicher, günstiger Seitenabruf pro
// Event mit einer muenchenticket.de-URL — andere Ticket-Hosts (eventim,
// reservix, ...) bleiben bewusst ohne Bild statt für jeden denkbaren Anbieter
// eine eigene og:image-Heuristik zu bauen.
const ogImageCache = new Map<string, string | null>();

async function fetchMuenchenTicketOgImage(ticketUrl: string): Promise<string | null> {
  if (ogImageCache.has(ticketUrl)) return ogImageCache.get(ticketUrl)!;
  let image: string | null = null;
  try {
    const res = await fetch(ticketUrl, { headers: BROWSER_HEADERS });
    if (res.ok) {
      const html = await res.text();
      const match = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
      image = match?.[1] ?? null;
    }
  } catch {
    // Bild bleibt null, kein harter Fehler für den restlichen Collector-Lauf.
  }
  ogImageCache.set(ticketUrl, image);
  return image;
}

async function fetchCategoryPage(categoryId: string, from: string, to: string, page: number): Promise<cheerio.CheerioAPI | null> {
  const query = new URLSearchParams({
    search: '1',
    type: 'intro',
    page: String(page),
    'field_subevent_start_date_value_1[date]': from,
    'field_subevent_end_date_value[date]': to,
    'field_category_one_target_id[]': categoryId,
  });
  const url = `${BASE_URL}?${query}`;

  const res = await fetch(url, { headers: BROWSER_HEADERS });
  if (!res.ok) {
    console.warn(`[muenchen-stadtportal] category ${categoryId} page ${page} failed`, res.status);
    return null;
  }
  const html = await res.text();
  return cheerio.load(html);
}

export async function run() {
  console.log('[muenchen-stadtportal] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[muenchen-stadtportal] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const today = new Date();
  const from = isoDate(today);
  const to = isoDate(addDays(today, HORIZON_DAYS - 1));
  const collected: any[] = [];

  for (const { id: categoryId, category } of CATEGORIES) {
    try {
      let page = 0;
      let sawAnyItem = false;
      while (page < MAX_PAGES_PER_CATEGORY) {
        const $ = await fetchCategoryPage(categoryId, from, to, page);
        await wait(requestSpacingMs());
        if (!$) break;

        const items = parseListingPage($);
        if (items.length === 0) break;
        sawAnyItem = true;

        for (const item of items) {
          if (item.startDate < isoDate(today)) continue;
          // Bewusst NICHT ticketUrl als Identität: dieselbe Aufführung wird
          // auf muenchen.de teils mit mehreren verschiedenen Ticket-Links
          // gezeigt (z.B. je Preiskategorie, oder mit einem pro Abruf
          // wechselnden Tracking-Parameter in der URL) — mit ticketUrl als
          // Hash-Grundlage erzeugte das bei jedem Collector-Lauf eine NEUE
          // source_id für dieselbe reale Veranstaltung, statt sie zu
          // aktualisieren (per Nutzer-Screenshot, 2026-08-09: "Dionysos" kam
          // an nur 3 Tagen auf 25 einzelne Zeilen). Titel+Ort ist die
          // stabile, tatsächliche Identität einer Aufführung.
          const idSource = `${item.title}::${item.locationName ?? ''}`;
          const coords = await getCoordinates(supabase, item.locationName ?? 'München', null, 'München');
          let imageUrl: string | null = null;
          const ticketHost = item.ticketUrl ? (() => { try { return new URL(item.ticketUrl!).hostname; } catch { return null; } })() : null;
          if (item.ticketUrl && ticketHost?.endsWith('muenchenticket.de')) {
            imageUrl = await fetchMuenchenTicketOgImage(item.ticketUrl);
            await wait(requestSpacingMs());
          }
          collected.push({
            source_id: buildStableSourceId(`muenchen-stadtportal-${categoryId}`, idSource, item.startDate),
            title: item.title,
            description: null,
            category,
            subcategory: null,
            start_date: item.startDate,
            start_time: item.startTime,
            end_date: item.endDate && item.endDate !== item.startDate ? item.endDate : null,
            location_name: item.locationName,
            address: null,
            city: 'München',
            organizer: null,
            // Kein Fallback auf BASE_URL mehr: das ist nur die generische
            // Kategorie-Listing-Seite, kein Bezug zu diesem konkreten Event
            // (per Nutzer-Meldung, 2026-08-09: "Jetzt geht's rund –
            // Kreisläufe statt Abfälle" landete dadurch auf einer
            // unrelated Konzert-Übersichtsseite). Events ohne eigenen
            // Ticket-Link (z.B. freier Eintritt) bekommen stattdessen gar
            // keinen source_url — die App blendet den Link dann aus, statt
            // auf etwas Irreführendes zu verweisen.
            source_url: item.ticketUrl ?? null,
            image_url: imageUrl,
            price_info: null,
            sold_out: null,
            latitude: coords?.latitude ?? null,
            longitude: coords?.longitude ?? null,
          });
        }

        page += 1;
      }
      console.log(`[muenchen-stadtportal] category ${category} (${categoryId}): ${page} Seiten, sawAnyItem=${sawAnyItem}`);
    } catch (err) {
      console.warn(`[muenchen-stadtportal] error for category ${category} (${categoryId})`, err);
    }
  }

  if (collected.length === 0) { console.log('[muenchen-stadtportal] no events parsed'); return; }
  console.log('[muenchen-stadtportal] upserting', collected.length, 'events');
  const { error } = await supabase.from('events').upsert(dedupeBySourceId(collected), { onConflict: 'source_id' });
  if (error) console.error('[muenchen-stadtportal] upsert error', error);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}

export default run;
