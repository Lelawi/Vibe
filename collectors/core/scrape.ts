// Gemeinsame Hilfsfunktionen zum Parsen von Event-Daten aus HTML-Seiten,
// genutzt von den Collectoren, die keine dedizierte API haben und daher
// öffentliche Veranstaltungsseiten scrapen.
import type { CheerioAPI } from 'cheerio';

export interface ParsedEvent {
  name: string | null;
  startDate: string | null;
  description: string | null;
  url: string | null;
  image: string | null;
  locationName: string | null;
  address: string | null;
  organizer: string | null;
}

function addressToString(a: any): string | null {
  if (!a) return null;
  if (typeof a === 'string') return a;
  return [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode].filter(Boolean).join(', ') || null;
}

function nodeToEvent(node: any): ParsedEvent | null {
  if (!node || typeof node !== 'object') return null;
  const location = node.location ?? null;
  let locationName: string | null = null;
  let address: string | null = null;
  if (location) {
    locationName = typeof location === 'string' ? location : location.name ?? null;
    address = addressToString(location.address);
  }
  return {
    name: node.name ?? null,
    startDate: node.startDate ?? null,
    description: node.description ?? null,
    url: node.url ?? node['@id'] ?? null,
    image: Array.isArray(node.image) ? node.image[0] : (node.image?.url ?? node.image ?? null),
    locationName,
    address,
    organizer: node.organizer?.name ?? null,
  };
}

// Sammelt alle schema.org "Event"-Knoten aus JSON-LD <script>-Tags einer Seite,
// inkl. verschachtelter @graph- und ItemList-Strukturen, wie sie von vielen
// deutschen CMS (TYPO3, WordPress-Eventplugins) für SEO ausgegeben werden.
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
    const isEvent = type === 'Event' || (Array.isArray(type) && type.includes('Event'));
    if (isEvent) {
      const ev = nodeToEvent(node);
      if (ev) events.push(ev);
    }
    if (Array.isArray(node['@graph'])) visit(node['@graph']);
    if (type === 'ItemList' && Array.isArray(node.itemListElement)) {
      for (const item of node.itemListElement) visit(item?.item ?? item);
    }
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

// Findet Links auf einer Seite, deren sichtbarer Text ein erkennbares Datum
// enthält (z.B. "Day Club Mi, 29.07.2026" oder "Konzert Jul 28"). Nützlich als
// letzter Fallback, wenn weder JSON-LD noch bekannte CSS-Klassen greifen —
// funktioniert unabhängig vom konkreten Markup, solange Titel+Datum im
// gleichen Link-Text stehen.
const NUMERIC_DATE = /\d{1,2}\.\d{1,2}\.\d{2,4}/;
const EN_ABBREV_DATE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i;

export function extractDatedLinks($: CheerioAPI, baseUrl: string): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  const seen = new Set<string>();

  $('a[href]').each((_, el) => {
    const a = $(el);
    const href = a.attr('href');
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;

    const text = a.text().replace(/\s+/g, ' ').trim();
    if (!text || text.length > 250) return;

    const numericMatch = text.match(NUMERIC_DATE);
    const enMatch = text.match(EN_ABBREV_DATE);
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
    const name = (dateToken ? text.replace(dateToken, '') : text).replace(/^[,\s-]+|[,\s-]+$/g, '').trim() || text.slice(0, 80);

    events.push({
      name: name || null,
      startDate: dateToken,
      description: null,
      url,
      image: null,
      locationName: null,
      address: null,
      organizer: null,
    });
  });

  return events;
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
