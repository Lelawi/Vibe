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
