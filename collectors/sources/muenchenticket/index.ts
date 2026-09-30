import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { berlinToday } from '../../core/timezone';

const ALGOLIA_APP_ID = 'UB6RVTVAFZ';
const ALGOLIA_API_KEY = '46f011a35c180f5a07a2210276ca04b7';
const ALGOLIA_URL = `https://${ALGOLIA_APP_ID.toLowerCase()}-dsn.algolia.net/1/indexes/*/queries`;

interface AlgoliaHit {
  objectID: string;
  event_object_id: string;
  event: { id: string; title: string; hero_media?: string[] };
  external_shop_link: string;
  uri: string;
  venue: { title: string; city: string };
  organizer?: { title: string };
  category?: { lvl0?: string; lvl1?: string };
  date: number;
  date_display_mode?: string;
  type?: string;
  visible: boolean;
  _geoloc?: { lat: number; lng: number };
  hero_media?: string[];
}

// hero_media kommt als "file://<id>" (interne Algolia-Referenz), das reale
// Bild liegt bei Cloudflare Images unter einer festen Account-URL — per
// direktem Seitenabruf verifiziert (og:image auf einer echten Event-Seite:
// https://www.muenchenticket.de/cdn-cgi/imagedelivery/<hash>/<id>/public).
const MUENCHENTICKET_IMAGE_BASE = 'https://www.muenchenticket.de/cdn-cgi/imagedelivery/G-nI_gKZu0ITxcZoDAx8pA';

function heroMediaToImageUrl(heroMedia?: string[]): string | null {
  const ref = heroMedia?.[0];
  if (!ref) return null;
  const id = ref.replace(/^file:\/\//, '');
  return id ? `${MUENCHENTICKET_IMAGE_BASE}/${id}/public` : null;
}

function unixToDateTime(unixSeconds: number) {
  const date = new Date(unixSeconds * 1000);
  const dateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
  const timeStr = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
  return { date: dateStr, time: timeStr };
}

// Algolia liefert pro Suche höchstens 1000 Treffer (paginationLimitedTo),
// es gibt aber ~2.450 kommende Aufführungen in München. Vorher wurde nur
// Seite 0 (300 Treffer) gelesen. Jetzt: Zeitraum in 30-Tage-Fenster teilen
// (per numericFilters auf date) und jedes Fenster vollständig abrufen.
const WINDOW_DAYS = 30;
const HORIZON_DAYS = 365;
const MAX_HITS_PER_QUERY = 1000;

async function queryAlgolia(fromUnix: number, toUnix: number, page: number): Promise<{ hits: AlgoliaHit[]; nbHits: number; nbPages: number }> {
  const params = new URLSearchParams({
    query: '',
    hitsPerPage: String(MAX_HITS_PER_QUERY),
    page: String(page),
    // Der Index gruppiert per distinct Aufführungen desselben Stücks — das
    // würde genau die Termine wieder zusammenfassen, die hier einzeln
    // gebraucht werden, und begrenzt hitsPerPage auf ~500 (bei 1000 kam
    // "400 Invalid distinct value", Lauf 2026-09-30).
    distinct: 'false',
    facetFilters: JSON.stringify([['venue.city:München']]),
    numericFilters: JSON.stringify([`date>=${fromUnix}`, `date<${toUnix}`]),
  }).toString();

  const response = await fetch(ALGOLIA_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Algolia-Api-Key': ALGOLIA_API_KEY,
      'X-Algolia-Application-Id': ALGOLIA_APP_ID,
    },
    body: JSON.stringify({
      requests: [{ indexName: 'prod_PERFORMANCES', params }],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`München Ticket API antwortete mit Status ${response.status}`);
  }

  const data = await response.json();
  return { hits: data.results[0].hits, nbHits: data.results[0].nbHits, nbPages: data.results[0].nbPages };
}

export async function fetchMuenchenTicketEvents(): Promise<AlgoliaHit[]> {
  const all: AlgoliaHit[] = [];
  const start = Math.floor(Date.now() / 1000) - 86_400; // gestern, Filter auf "heute" folgt in run()
  for (let offset = 0; offset < HORIZON_DAYS; offset += WINDOW_DAYS) {
    const from = start + offset * 86_400;
    const to = start + (offset + WINDOW_DAYS) * 86_400;
    // Normalerweise eine Seite (~700 Aufführungen pro 30 Tage); weitere
    // Seiten nur zur Sicherheit. Algolia liefert pro Suche insgesamt max.
    // 1000 Treffer — darüber hilft nur ein kleineres Fenster.
    const first = await queryAlgolia(from, to, 0);
    all.push(...first.hits);
    for (let page = 1; page < first.nbPages; page++) {
      all.push(...(await queryAlgolia(from, to, page)).hits);
    }
    if (first.nbHits > MAX_HITS_PER_QUERY) {
      console.warn(`[muenchenticket] Fenster ab Tag ${offset}: ${first.nbHits} Treffer, nur ${MAX_HITS_PER_QUERY} abrufbar — WINDOW_DAYS verkleinern`);
    }
  }
  return all;
}

function normalizeEvent(hit: AlgoliaHit) {
  const { date, time } = unixToDateTime(hit.date);
  const rawSubcategory = hit.category?.lvl1;
  const subcategory = rawSubcategory?.includes('>')
    ? rawSubcategory.split('>')[1].trim()
    : rawSubcategory ?? null;

  return {
    // Pro Aufführung (objectID), nicht pro Stück: vorher fielen alle Termine
    // eines Stücks auf eine source_id zusammen und der zuletzt gelesene
    // gewann ("PHILOPHOBIA" stand nur auf dem 20.10., obwohl es auch am
    // 30.09. und 01.10. lief).
    source_id: `muenchenticket-${hit.event_object_id}-${hit.objectID}`,
    title: hit.event.title,
    description: null,
    category: hit.category?.lvl0 ?? 'Sonstiges',
    subcategory,
    start_date: date,
    start_time: time,
    location_name: hit.venue.title,
    address: null,
    city: hit.venue.city,
    organizer: hit.organizer?.title ?? hit.venue.title,
    source_url: hit.external_shop_link || `https://www.muenchenticket.de/${hit.uri}`,
    image_url: heroMediaToImageUrl(hit.event?.hero_media ?? hit.hero_media),
    latitude: hit._geoloc?.lat ?? null,
    longitude: hit._geoloc?.lng ?? null,
  };
}

export async function run() {
  console.log('München-Ticket-Collector gestartet...');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[muenchenticket] missing supabase envs — skipping'); return; }

  const hits = await fetchMuenchenTicketEvents();
  console.log(`${hits.length} Treffer von München Ticket erhalten`);

  const today = berlinToday();
  const realEvents = hits.filter(
    (h) =>
      h.visible &&
      h.type !== 'MUSEUM' &&
      h.date_display_mode !== 'hide_all' &&
      unixToDateTime(h.date).date >= today
  );
  console.log(`${realEvents.length} davon mit echtem, zukünftigem Termin`);

  const normalizedEvents = realEvents.map(normalizeEvent);

  const deduplicatedMap = new Map(normalizedEvents.map((e) => [e.source_id, e]));
  const deduplicatedEvents = Array.from(deduplicatedMap.values());
  console.log(`${deduplicatedEvents.length} nach Entfernen von Duplikaten`);

  const supabase = createClient(supabaseUrl, supabaseKey);
  const { error } = await supabase
    .from('events')
    .upsert(deduplicatedEvents, { onConflict: 'source_id' });

  if (error) {
    console.error('Fehler beim Speichern:', error);
    return;
  }

  console.log(`${deduplicatedEvents.length} Events gespeichert/aktualisiert.`);

  // Altbestand im früheren Format "muenchenticket-<event_object_id>" (ein
  // Termin pro Stück, siehe normalizeEvent) entfernen — erst nach einem
  // erfolgreichen Upsert mit plausibler Menge, damit ein leerer oder
  // gescheiterter Abruf nicht den Bestand löscht.
  if (deduplicatedEvents.length >= 100) {
    const { error: legacyError, count } = await supabase
      .from('events')
      .delete({ count: 'exact' })
      .filter('source_id', 'match', '^muenchenticket-[A-Za-z0-9]+$');
    if (legacyError) console.warn('[muenchenticket] Altbestand konnte nicht entfernt werden', legacyError);
    else if (count) console.log(`[muenchenticket] ${count} Zeilen im alten ID-Format entfernt`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

export default run;