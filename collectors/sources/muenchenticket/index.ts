import { createClient } from '@supabase/supabase-js';

const OUR_SUPABASE_URL = process.env.SUPABASE_URL!;
const OUR_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const ALGOLIA_APP_ID = 'UB6RVTVAFZ';
const ALGOLIA_API_KEY = '46f011a35c180f5a07a2210276ca04b7';
const ALGOLIA_URL = `https://${ALGOLIA_APP_ID.toLowerCase()}-dsn.algolia.net/1/indexes/*/queries`;

interface AlgoliaHit {
  event_object_id: string;
  event: { id: string; title: string };
  external_shop_link: string;
  uri: string;
  venue: { title: string; city: string };
  organizer?: { title: string };
  category?: { lvl0?: string; lvl1?: string };
  date: number;
  date_display_mode?: string;
  type?: string;
  visible: boolean;
}

// Wandelt einen Unix-Zeitstempel korrekt in München-Ortszeit um
function unixToDateTime(unixSeconds: number) {
  const date = new Date(unixSeconds * 1000);
  const dateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date); // Format: YYYY-MM-DD
  const timeStr = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
  return { date: dateStr, time: timeStr };
}

async function fetchMuenchenTicketEvents(): Promise<AlgoliaHit[]> {
  const params = new URLSearchParams({
    query: '',
    hitsPerPage: '300',
    page: '0',
    facetFilters: JSON.stringify([['venue.city:München']]),
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
  });

  if (!response.ok) {
    throw new Error(`München Ticket API antwortete mit Status ${response.status}`);
  }

  const data = await response.json();
  return data.results[0].hits;
}

function normalizeEvent(hit: AlgoliaHit) {
  const { date, time } = unixToDateTime(hit.date);
  const rawSubcategory = hit.category?.lvl1;
  const subcategory = rawSubcategory?.includes('>')
    ? rawSubcategory.split('>')[1].trim()
    : rawSubcategory ?? null;

  return {
    source_id: `muenchenticket-${hit.event_object_id}`,
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
    image_url: null,
  };
}

async function main() {
  console.log('München-Ticket-Collector gestartet...');

  const hits = await fetchMuenchenTicketEvents();
  console.log(`${hits.length} Treffer von München Ticket erhalten`);

  // Nur echte Einzeltermine behalten (keine Dauerausstellungen o.Ä.)
  const todayUnix = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
  const realEvents = hits.filter(
    (h) =>
      h.visible &&
      h.type !== 'MUSEUM' &&
      h.date_display_mode !== 'hide_all' &&
      h.date >= todayUnix
  );
  console.log(`${realEvents.length} davon mit echtem Termin`);

  const normalizedEvents = realEvents.map(normalizeEvent);

  // Duplikate innerhalb derselben Charge entfernen (gleiche source_id)
  const deduplicatedMap = new Map(normalizedEvents.map((e) => [e.source_id, e]));
  const deduplicatedEvents = Array.from(deduplicatedMap.values());
  console.log(`${deduplicatedEvents.length} nach Entfernen von Duplikaten`);

  const supabase = createClient(OUR_SUPABASE_URL, OUR_SERVICE_ROLE_KEY);
  const { error } = await supabase
    .from('events')
    .upsert(deduplicatedEvents, { onConflict: 'source_id' });

  if (error) {
    console.error('Fehler beim Speichern:', error);
    process.exit(1);
  }

  console.log(`${deduplicatedEvents.length} Events gespeichert/aktualisiert.`);
}

main();