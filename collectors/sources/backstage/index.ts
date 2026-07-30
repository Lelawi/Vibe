import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { getCoordinates } from '../../core/geocode';

const BACKSTAGE_API_URL =
  'https://vhhdjliwckyzbqtjrjpp.supabase.co/rest/v1/rpc/get_upcoming_events';
const BACKSTAGE_API_KEY = 'sb_publishable__7zXOMfMEPpplHogPxLazQ_iaXgzJfS';
const BACKSTAGE_ADDRESS = 'Reitknechtstr. 6, 80639 München';

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
  main_image_path: string | null;
  min_price_cents: number | null;
  subtitle: string | null;
}

// main_image_path ist relativ ("<event_id>/<file>.webp") — die Backstage-API
// selbst läuft auf Supabase (vhhdjliwckyzbqtjrjpp), Bilder liegen im
// öffentlichen "media"-Storage-Bucket desselben Projekts; per Direktabruf
// verifiziert (200, image/webp).
const BACKSTAGE_IMAGE_BASE =
  'https://vhhdjliwckyzbqtjrjpp.supabase.co/storage/v1/object/public/media';

function backstageImageUrl(path: string | null): string | null {
  return path ? `${BACKSTAGE_IMAGE_BASE}/${path}` : null;
}

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

// Räume, die wirklich zum Backstage-Gelände gehören (feste Adresse)
const BACKSTAGE_OWN_VENUES = [
  'backstage halle',
  'backstage club',
  'backstage werk',
  'backstage werkstatt',
  'backstage werkstatt-studio',
  'backstage arena',
  'backstage arena süd',
  'backstage arena süd open air (überdacht)',
  'backstage all area',
  'backstage biergarten',
  'backyard open air (überdacht)',
];

async function normalizeEvent(raw: BackstageEvent, supabase: ReturnType<typeof createClient>) {
  const startDateTime = new Date(raw.start_time);
  const startDate = startDateTime.toISOString().slice(0, 10);
  const startTime = startDateTime.toISOString().slice(11, 16);

  const subcategory = raw.genres?.length
    ? raw.genres.map((g) => g.name).join(', ')
    : null;

  const locationName = raw.location_name ?? 'Backstage München';
  const isOwnVenue = BACKSTAGE_OWN_VENUES.includes(locationName.toLowerCase());

  // Nur bei eigenen Räumen die feste Adresse erzwingen - bei fremden Locations
  // (z.B. Muffathalle, Zenith) den echten Namen selbst geokodieren lassen
  const coords = await getCoordinates(
    supabase,
    locationName,
    isOwnVenue ? BACKSTAGE_ADDRESS : null,
    'München'
  );

  return {
    source_id: `backstage-${raw.event_id}`,
    title: raw.title,
    description: raw.subtitle || null,
    category: raw.category ?? 'Sonstiges',
    subcategory,
    start_date: startDate,
    start_time: startTime,
    location_name: locationName,
    address: isOwnVenue ? BACKSTAGE_ADDRESS : null,
    city: 'München',
    organizer: 'Backstage München',
    source_url: `https://www.backstage.eu/event/${raw.event_id}`,
    image_url: backstageImageUrl(raw.main_image_path),
    // min_price_cents ist bei ~63% aller Events null (per Direktabruf
    // verifiziert, 2026-07) — das heißt i.d.R. nur "keine Ticketpreis-Daten
    // vorhanden" (z.B. Fremdlocations, externe Ticketwege), nicht "kostenlos".
    // Die explizite category "free & easy" ist dagegen ein echtes Signal des
    // Anbieters selbst für die eigene "Free & Easy"-Eventreihe im Biergarten/
    // Backyard — nur dort lässt sich null zuverlässig als "Kostenlos" lesen.
    price_info:
      raw.min_price_cents === 0
        ? 'Kostenlos'
        : raw.min_price_cents != null
        ? `ab ${(raw.min_price_cents / 100).toFixed(2)} €`
        : raw.category?.toLowerCase() === 'free & easy'
        ? 'Kostenlos'
        : null,
    latitude: coords?.latitude ?? null,
    longitude: coords?.longitude ?? null,
  };
}

export async function run() {
  console.log('Backstage Collector gestartet...');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[backstage] missing supabase envs — skipping'); return; }

  const rawEvents = await fetchBackstageEvents();
  console.log(`${rawEvents.length} Events von Backstage erhalten`);

  const today = new Date().toISOString().slice(0, 10);
  const activeEvents = rawEvents.filter(
    (e) => !e.cancelled && e.start_time.slice(0, 10) >= today
  );

  const supabase = createClient(supabaseUrl, supabaseKey);

  // Nacheinander statt parallel, damit die Geokodierungs-Rate-Limits eingehalten werden
  const normalizedEvents = [];
  for (const event of activeEvents) {
    normalizedEvents.push(await normalizeEvent(event, supabase));
  }

  const { error } = await supabase
    .from('events')
    .upsert(normalizedEvents, { onConflict: 'source_id' });

  if (error) {
    console.error('Fehler beim Speichern:', error);
    return;
  }

  console.log(`${normalizedEvents.length} Events gespeichert/aktualisiert.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

export default run;