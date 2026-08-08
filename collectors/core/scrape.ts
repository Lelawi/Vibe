// Gemeinsame Hilfsfunktionen zum Parsen von Event-Daten aus HTML-Seiten,
// genutzt von den Collectoren, die keine dedizierte API haben und daher
// öffentliche Veranstaltungsseiten scrapen.
import type { CheerioAPI } from 'cheerio';
import fetch from 'node-fetch';
import { createHash } from 'crypto';

export interface ParsedEvent {
  name: string | null;
  startDate: string | null;
  endDate: string | null;
  description: string | null;
  url: string | null;
  image: string | null;
  locationName: string | null;
  address: string | null;
  organizer: string | null;
  priceInfo: string | null;
  soldOut: boolean | null;
  latitude: number | null;
  longitude: number | null;
}

function addressToString(a: any): string | null {
  if (!a) return null;
  if (typeof a === 'string') return a;
  return [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode].filter(Boolean).join(', ') || null;
}

// schema.org Event.offers ist ein einzelnes Offer-Objekt oder ein Array davon.
// Baut daraus einen Freitext-Preis ("12 EUR", "ab 12 EUR" bei mehreren Preisen)
// und liest availability für den Ausverkauft-Status aus.
function offersToPriceInfo(offers: any): { priceInfo: string | null; soldOut: boolean | null } {
  if (!offers) return { priceInfo: null, soldOut: null };
  const list = Array.isArray(offers) ? offers : [offers];
  // Die meisten Quellen liefern einzelne Offer-Objekte mit "price", manche
  // (z.B. eventbrite.de-Detailseiten) fassen mehrere Ticketstufen stattdessen
  // zu einem einzigen "AggregateOffer" mit "lowPrice"/"highPrice" zusammen
  // (schema.org-konform, aber ein anderes Feld) — ohne diesen Fallback blieb
  // priceInfo dort trotz vorhandener Preisdaten leer (per Direktabruf
  // verifiziert, 2026-08). Number(...) statt eines reinen typeof-Checks, da
  // beide Varianten die Zahl teils als String liefern ("12.0").
  const rawPrices = list
    .flatMap((o) => {
      if (o?.price !== undefined && o?.price !== null && o?.price !== '') return [Number(o.price)];
      const low = o?.lowPrice !== undefined && o?.lowPrice !== null && o?.lowPrice !== '' ? Number(o.lowPrice) : null;
      const high = o?.highPrice !== undefined && o?.highPrice !== null && o?.highPrice !== '' ? Number(o.highPrice) : null;
      return [low, high].filter((p): p is number => p !== null);
    })
    .filter((p): p is number => p !== null && !isNaN(p));
  // Ein AggregateOffer mit lowPrice === highPrice ist ein einzelner Festpreis,
  // keine echte Spanne — sonst würde er unten fälschlich als "ab X EUR"
  // statt als "X EUR" angezeigt.
  const numericPrices = [...new Set(rawPrices)];

  // "0 EUR" statt "Kostenlos" sah neben anderen Quellen inkonsistent aus
  // (per Nutzer-Feedback, 2026-08-08) — andere Collector (z.B.
  // muenchen_stadtportal) schreiben für kostenlose Events explizit
  // "Kostenlos", nicht "0 EUR"/"0.0 EUR".
  let priceInfo: string | null = null;
  if (numericPrices.length > 0 && numericPrices.every((p) => p === 0)) {
    priceInfo = 'Kostenlos';
  } else if (numericPrices.length === 1) {
    priceInfo = `${numericPrices[0]} EUR`;
  } else if (numericPrices.length > 1) {
    priceInfo = `ab ${Math.min(...numericPrices)} EUR`;
  }

  const availability: string | undefined = list[0]?.availability;
  let soldOut: boolean | null = null;
  if (typeof availability === 'string') {
    if (availability.includes('SoldOut')) soldOut = true;
    else if (availability.includes('InStock') || availability.includes('InStoreOnly') || availability.includes('LimitedAvailability')) soldOut = false;
  }

  return { priceInfo, soldOut };
}

function nodeToEvent(node: any): ParsedEvent | null {
  if (!node || typeof node !== 'object') return null;
  const location = node.location ?? null;
  let locationName: string | null = null;
  let address: string | null = null;
  let latitude: number | null = null;
  let longitude: number | null = null;
  if (location) {
    locationName = typeof location === 'string' ? location : location.name ?? null;
    address = addressToString(location.address);
    // geo.latitude/longitude sind laut schema.org "Number", manche Quellen
    // liefern sie aber als Zahl-in-Anführungszeichen (z.B. eventbrite.de:
    // "latitude":"48.1437759" statt 48.1437759) — ein reiner typeof
    // === 'number'-Check verwarf diese Koordinaten bisher stillschweigend,
    // obwohl echte, brauchbare Werte vorlagen (per Direktabruf verifiziert,
    // 2026-08). Number(...) akzeptiert beide Schreibweisen; isNaN fängt
    // echten Unsinn (leere Strings, Text) weiterhin ab.
    const geo = location.geo;
    if (geo) {
      const lat = Number(geo.latitude);
      const lng = Number(geo.longitude);
      if (!isNaN(lat) && !isNaN(lng) && geo.latitude !== null && geo.longitude !== null) {
        latitude = lat;
        longitude = lng;
      }
    }
  }
  const { priceInfo, soldOut } = offersToPriceInfo(node.offers);
  return {
    name: node.name ?? null,
    startDate: node.startDate ?? null,
    endDate: node.endDate ?? null,
    description: node.description ?? null,
    url: node.url ?? node['@id'] ?? null,
    image: Array.isArray(node.image) ? node.image[0] : (node.image?.url ?? node.image ?? null),
    locationName,
    address,
    organizer: node.organizer?.name ?? null,
    priceInfo,
    soldOut,
    latitude,
    longitude,
  };
}

// schema.org kennt neben dem generischen "Event" auch benannte Subtypen
// (TheaterEvent, MusicEvent, ComedyEvent, ScreeningEvent, SportsEvent,
// ExhibitionEvent, ...), die alle gültige Event-Knoten sind. in-muenchen.de
// nutzt genau das (TheaterEvent) für seine Venue-Seiten — ein reiner
// "=== 'Event'"-Vergleich hätte diese Knoten komplett ignoriert (per
// Direktabruf verifiziert, 2026-07: dadurch griff für alle ~19
// in-muenchen.de-Collectors nie diese JSON-LD-Route, sondern immer der
// schwächere extractInMuenchenTeasers()-Fallback, obwohl die echten Daten
// die ganze Zeit im JSON-LD lagen — inklusive echter Ticketpreise über
// offers.price, die die separate checkInMuenchenFreeEntry()-Detailseiten-
// Prüfung strukturell nie findet, weil die Event-Detailseite selbst nie
// Beträge zeigt, nur die hier gescrapte Venue-Übersichtsseite).
function isEventType(type: unknown): boolean {
  if (typeof type === 'string') return type === 'Event' || type.endsWith('Event');
  if (Array.isArray(type)) return type.some(isEventType);
  return false;
}

// Sammelt alle schema.org "Event"-Knoten aus JSON-LD <script>-Tags einer Seite,
// inkl. verschachtelter @graph-, ItemList- und LocalBusiness/Place.event-
// Strukturen, wie sie von vielen deutschen CMS (TYPO3, WordPress-
// Eventplugins) für SEO ausgegeben werden.
export function extractJsonLdEvents($: CheerioAPI): ParsedEvent[] {
  const events: ParsedEvent[] = [];

  const visit = (node: any) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node !== 'object') return;

    const type = node['@type'];
    if (isEventType(type)) {
      const ev = nodeToEvent(node);
      if (ev) events.push(ev);
    }
    if (Array.isArray(node['@graph'])) visit(node['@graph']);
    if (type === 'ItemList' && Array.isArray(node.itemListElement)) {
      for (const item of node.itemListElement) visit(item?.item ?? item);
    }
    // z.B. LocalBusiness/Place mit einem verschachtelten "event"-Feld
    // (Einzelobjekt oder Array) — nicht selbst ein Event-Knoten, aber Träger
    // von welchen.
    if (node.event) visit(node.event);
  };

  const scripts = $('script[type="application/ld+json"]')
    .toArray()
    .map((el) => $(el).html())
    .filter(Boolean);

  for (const raw of scripts) {
    try {
      visit(JSON.parse(raw!));
    } catch {
      // ignore malformed JSON-LD blocks
    }
  }

  return events;
}

// Baut eine URL -> Preisinfo-Map aus dem JSON-LD einer in-muenchen.de-Venue-
// Seite. Bewusst als Zusatzquelle statt als Ersatz für extractInMuenchenTeasers:
// das JSON-LD zeigt pro Seite nur die nächsten ~25 Termine (per Direktabruf
// verifiziert, 2026-07: 25 JSON-LD-Events gegenüber 80-100 Teaser-Events auf
// derselben Seite), die Teaser-Liste dagegen alle sichtbaren Termine. Nur für
// die überlappende Teilmenge lässt sich so der echte Ticketpreis ergänzen,
// den checkInMuenchenFreeEntry() strukturell nie findet (die Event-
// Detailseite selbst zeigt nie Beträge, nur "Eintritt frei" oder gar nichts).
export function extractJsonLdPricesByUrl($: CheerioAPI): Map<string, string> {
  const map = new Map<string, string>();
  for (const ev of extractJsonLdEvents($)) {
    if (ev.url && ev.priceInfo) map.set(ev.url, ev.priceInfo);
  }
  return map;
}

// Findet Links auf einer Seite, deren sichtbarer Text ein erkennbares Datum
// enthält (z.B. "Day Club Mi, 29.07.2026" oder "Konzert Jul 28"). Nützlich als
// letzter Fallback, wenn weder JSON-LD noch bekannte CSS-Klassen greifen —
// funktioniert unabhängig vom konkreten Markup, solange Titel+Datum im
// gleichen Link-Text stehen.
// Erfordert eine vierstellige Jahreszahl (statt 2-4-stellig), damit zufällige
// Zahlenfolgen im Seitentext (Telefonnummern, Kurz-IDs etc.) nicht versehentlich
// als Datum mit falschem Jahrhundert interpretiert werden.
const NUMERIC_DATE = /\d{1,2}\.\d{1,2}\.\d{4}/;
const EN_ABBREV_DATE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i;

export function extractDatedLinks($: CheerioAPI, baseUrl: string, cityHint = 'München'): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  const seen = new Set<string>();

  $('a[href]').each((_, el) => {
    const a = $(el);
    const href = a.attr('href');
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) return;

    const ownText = a.text().replace(/\s+/g, ' ').trim();
    if (!ownText) return;

    // Manche Karten-Layouts trennen Titel-Link und Datum in Geschwister-
    // Elemente statt beides im selben <a> zu verschachteln — deshalb zusätzlich
    // im direkten Elternelement nach einem Datum suchen, falls der Link selbst
    // keins enthält.
    const parentText = a.parent().text().replace(/\s+/g, ' ').trim();
    const scanText = ownText.length > 250 ? ownText.slice(0, 250) : (parentText.length <= 400 ? parentText : ownText);

    const numericMatch = scanText.match(NUMERIC_DATE);
    const enMatch = scanText.match(EN_ABBREV_DATE);
    if (!numericMatch && !enMatch) return;

    let url: string;
    try {
      url = new URL(href, baseUrl).toString();
    } catch {
      return;
    }
    if (seen.has(url)) return;
    seen.add(url);

    const dateToken = numericMatch?.[0] ?? enMatch?.[0] ?? null;
    let rest = (dateToken ? ownText.replace(dateToken, '') : ownText).replace(/^[,\s-]+|[,\s-]+$/g, '').trim();
    if (!rest) rest = scanText.replace(dateToken ?? '', '').trim();

    // Viele Listing-Seiten hängen "<Venue>, <Stadt> (DE)" ans Ende des Texts —
    // wenn das Muster greift, Venue vom Titel abtrennen.
    let name = rest;
    let locationName: string | null = null;
    const venueMatch = rest.match(new RegExp(`([^,]+),\\s*${cityHint}\\s*\\(DE\\)`, 'i'));
    if (venueMatch) {
      locationName = venueMatch[1].trim();
      name = rest.slice(0, venueMatch.index).trim() || rest;
    }

    events.push({
      name: (name || rest || scanText).slice(0, 200) || null,
      startDate: dateToken,
      endDate: null,
      description: null,
      url,
      image: null,
      locationName,
      address: null,
      organizer: null,
      priceInfo: null,
      soldOut: null,
      latitude: null,
      longitude: null,
    });
  });

  return events;
}

// in-muenchen.de-spezifischer Extractor (genutzt von p1, muenchen_de). Echte
// Markup-Struktur per direktem HTML-Abruf verifiziert (2026-07):
// <div class="teaser-item">
//   <div class="teaser-info">
//     <div class="title-row"><a class="title" href="...">Titel</a></div>
//     <div class="meta">
//       <div class="date"><span>Mi, 29.07.2026, 19:00 Uhr</span></div>
//       <div class="location"><div></div><div><a>Venue</a></div></div>
export function extractInMuenchenTeasers($: CheerioAPI, baseUrl: string): ParsedEvent[] {
  const events: ParsedEvent[] = [];

  $('.teaser-item').each((_, el) => {
    const el$ = $(el);
    const titleLink = el$.find('.title-row a, a.title').first();
    const name = titleLink.text().trim();
    const href = titleLink.attr('href');
    if (!name || !href) return;

    const dateText = el$.find('.date span, .date').first().text().trim();
    const locationName = el$.find('.location a').first().text().trim() || null;
    const imageSrc = el$.find('.image-wrapper img, img').first().attr('src') || null;
    const description = el$.find('a.description').first().text().trim() || null;

    let url: string;
    try {
      url = new URL(href, baseUrl).toString();
    } catch {
      return;
    }

    let image: string | null = null;
    if (imageSrc) {
      try {
        image = new URL(imageSrc, baseUrl).toString();
      } catch {
        image = null;
      }
    }

    events.push({
      name,
      startDate: dateText || null,
      endDate: null,
      description,
      url,
      image,
      locationName,
      address: null,
      organizer: null,
      priceInfo: null,
      soldOut: null,
      latitude: null,
      longitude: null,
    });
  });

  return events;
}

// in-muenchen.de zeigt auf der Event-Detailseite (nicht auf der hier
// gescrapten Venue-Übersicht) "Eintritt frei" für kostenlose Events an —
// echte Ticketpreise zeigt die Seite dagegen nie an (nur ein Link zum
// externen Ticketanbieter wie eventim.de), es gibt also nur einen
// Kostenlos-Status zu erkennen, keinen Betrag. Braucht einen zusätzlichen
// Seitenabruf pro Event, drosselt sich deshalb selbst (Aufrufer müssen NICHT
// zusätzlich pausieren) — mehrere Collector nutzen denselben Host.
const IN_MUENCHEN_DETAIL_DELAY_MS = 800;

export async function checkInMuenchenFreeEntry(eventUrl: string): Promise<string | null> {
  try {
    const res = await fetch(eventUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    });
    const html = res.ok ? await res.text() : '';
    return /eintritt\s*frei/i.test(html) ? 'Kostenlos' : null;
  } catch {
    return null;
  } finally {
    await new Promise((r) => setTimeout(r, IN_MUENCHEN_DETAIL_DELAY_MS));
  }
}

const EN_MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// Parst "Jul 28" / "Jul 28 2026"-artige englische Kurzformen, wie sie z.B.
// eventfrog.de für Datumsangaben ohne Jahreszahl nutzt.
export function parseAbbrevEnglishDate(text: string, reference = new Date()): string | null {
  const m = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b\s*,?\s*(\d{4})?/i);
  if (!m) return null;
  const month = EN_MONTHS[m[1].toLowerCase()];
  const day = parseInt(m[2], 10);
  let year = m[3] ? parseInt(m[3], 10) : reference.getFullYear();
  let candidate = new Date(Date.UTC(year, month - 1, day));
  if (!m[3] && candidate < reference) {
    year += 1;
    candidate = new Date(Date.UTC(year, month - 1, day));
  }
  return isNaN(candidate.getTime()) ? null : candidate.toISOString().slice(0, 10);
}

const GERMAN_MONTHS: Record<string, number> = {
  januar: 1, februar: 2, märz: 3, maerz: 3, april: 4, mai: 5, juni: 6, juli: 7,
  august: 8, september: 9, oktober: 10, november: 11, dezember: 12,
};

// Parst deutsche Datumsformate wie "18.07.2026", "18.07." (Jahr wird aus dem
// nächsten zukünftigen Vorkommen ermittelt) oder "18. Juli 2026" zu einem
// ISO-Datum (YYYY-MM-DD). Gibt null zurück, wenn nichts erkannt wird.
export function parseGermanDate(text: string, reference = new Date()): string | null {
  if (!text) return null;

  const numeric = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})?/);
  if (numeric) {
    const day = parseInt(numeric[1], 10);
    const month = parseInt(numeric[2], 10);
    let year = numeric[3] ? parseInt(numeric[3], 10) : reference.getFullYear();
    let candidate = new Date(Date.UTC(year, month - 1, day));
    if (!numeric[3] && candidate < reference) {
      year += 1;
      candidate = new Date(Date.UTC(year, month - 1, day));
    }
    if (!isNaN(candidate.getTime())) return candidate.toISOString().slice(0, 10);
  }

  const named = text
    .toLowerCase()
    .match(/(\d{1,2})\.?\s+(januar|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember)\s*(\d{4})?/);
  if (named) {
    const day = parseInt(named[1], 10);
    const month = GERMAN_MONTHS[named[2]];
    let year = named[3] ? parseInt(named[3], 10) : reference.getFullYear();
    let candidate = new Date(Date.UTC(year, month - 1, day));
    if (!named[3] && candidate < reference) {
      year += 1;
      candidate = new Date(Date.UTC(year, month - 1, day));
    }
    if (!isNaN(candidate.getTime())) return candidate.toISOString().slice(0, 10);
  }

  return null;
}

// Erzeugt eine stabile, kollisionsarme source_id aus einer Event-URL.
// Frühere Fassung nutzte `Buffer.from(url).toString('base64').slice(0, 20)`
// — base64 kodiert 3 Bytes zu 4 Zeichen, ein 20-Zeichen-Schnitt hängt also
// nur von den ERSTEN 15 Bytes der URL ab. Da alle in-muenchen.de-URLs mit
// demselben "https://www.in-muenchen.de/..."-Präfix beginnen, lieferte das
// für JEDES Event derselben Quelle exakt dieselbe source_id — der gesamte
// Upsert-Batch schlug dadurch mit "ON CONFLICT DO UPDATE command cannot
// affect row a second time" fehl, sobald eine Quelle mehr als ein Event
// fand (verifiziert 2026-07 in einem echten Collector-Lauf: praktisch alle
// in-muenchen.de-Quellen mit >1 Event betroffen, dadurch 0 gespeicherte
// Events trotz erfolgreichem Scraping). md5 über die volle URL vermeidet
// das Präfix-Kollisionsproblem; zusätzlich date anhängen, falls dieselbe
// URL für mehrere Termine einer wiederkehrenden Reihe steht.
export function buildStableSourceId(prefix: string, url: string, date: string): string {
  const hash = createHash('md5').update(url).digest('hex').slice(0, 16);
  return `${prefix}-${hash}-${date}`;
}

// Entfernt Duplikate anhand von source_id, bevor sie an Supabase upsert
// übergeben werden — Postgres kann eine ON-CONFLICT-DO-UPDATE-Regel
// innerhalb ein und desselben Batches nicht zweimal auf dieselbe Zeile
// anwenden und bricht sonst den kompletten Batch ab (siehe
// buildStableSourceId-Kommentar). Reine Absicherung zusätzlich zur
// eigentlichen Ursachenbehebung, für den Fall dass eine Quelle aus anderem
// Grund doch zwei Events mit identischer source_id liefert.
export function dedupeBySourceId<T extends { source_id: string }>(events: T[]): T[] {
  const map = new Map<string, T>();
  for (const e of events) map.set(e.source_id, e);
  return Array.from(map.values());
}
