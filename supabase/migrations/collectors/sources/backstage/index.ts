import { createClient } from '@supabase/supabase-js';

// Zugang zu UNSEREM eigenen Supabase-Projekt (kommt aus GitHub Secrets, siehe unten)
const OUR_SUPABASE_URL = process.env.SUPABASE_URL!;
const OUR_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Der öffentliche API-Endpunkt von Backstage (siehe Netzwerk-Analyse)
const BACKSTAGE_API_URL =
  'https://vhhdjliwckyzbqtjrjpp.supabase.co/rest/v1/rpc/get_upcoming_events';
const BACKSTAGE_API_KEY = 'sb_publishable__7zXOMfMEPpplHogPxLazQ_iaXgzJfS';

interface BackstageGenre {
  genre_id: string;
  name: string;
}

interface BackstageEvent {
  event_id: string;
  start_time: string;
  title: string;
  category: string | null;
  genres: BackstageGenre[];
  location_name: string | null;
  cancelled: boolean;
}

// Ruft die Rohdaten von Backstage ab
async function fetchBackstageEvents(): Promise<BackstageEvent[]> {
  const url = `${BACKSTAGE_API_URL}?order=start_time.asc&limit=1000`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: BACKSTAGE_API_KEY,
      Authorization: `Bearer ${BACKSTAGE_API_KEY}`,
    },
    body: JSON.stringify({ limit_count: 1000, offset_count: 0 }),
  });

  if (!response.ok) {
    throw new Error(`Backstage API antwortete mit Status ${response.status}`);
  }

  return response.json();
}

// Wandelt ein Backstage-Event in unser einheitliches Format um
function normalizeEvent(raw: BackstageEvent) {
  const startDateTime = new Date(raw.start_time);
  const startDate = startDateTime.toISOString().slice(0, 10); // "2026-07-27"
  const startTime = startDateTime.toISOString().slice(11, 16); // "16:30"

  const subcategory = raw.genres?.length
    ? raw.genres.map((g) => g.name).join(', ')
    : null;

  return {
    source_id: `backstage-${raw.event_id}`,
    title: raw.title,
    description: null,
    category: raw.category ?? 'Sonstiges',
    subcategory,
    start_date: startDate,
    start_time: startTime,
    location_name: raw.location_name ?? 'Backstage München',
    address: 'Reitknechtstr. 6, 80639 München',
    city: 'München',
    organizer: 'Backstage München',
    source_url: 'https://www.backstage.eu/events',
    image_url: null,
  };
}

async function main() {
  console.log('Backstage Collector gestartet...');

  const rawEvents = await fetchBackstageEvents();
  console.log(`${rawEvents.length} Events von Backstage erhalten`);

  // Abgesagte Events überspringen wir
  const activeEvents = rawEvents.filter((e) => !e.cancelled);
  const normalizedEvents = activeEvents.map(normalizeEvent);

  const supabase = createClient(OUR_SUPABASE_URL, OUR_SERVICE_ROLE_KEY);

  // "upsert" = einfügen ODER aktualisieren, falls source_id schon existiert
  const { error } = await supabase
    .from('events')
    .upsert(normalizedEvents, { onConflict: 'source_id' });

  if (error) {
    console.error('Fehler beim Speichern:', error);
    process.exit(1);
  }

  console.log(`${normalizedEvents.length} Events gespeichert/aktualisiert.`);
}

main();
