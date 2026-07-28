import { createClient } from '@supabase/supabase-js';
import { getCoordinates } from '../../core/geocode';

const OUR_SUPABASE_URL = process.env.SUPABASE_URL!;
const OUR_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Resident Advisor (club/electronic events) — implement scraping/API as needed
async function normalizeEvent(raw: any, supabase: ReturnType<typeof createClient>) {
  return {
    source_id: `ra-${raw.id}`,
    title: raw.title ?? 'Unnamed',
    description: raw.description ?? null,
    category: 'Clubs',
    subcategory: null,
    start_date: raw.date ?? null,
    start_time: raw.time ?? null,
    location_name: raw.venue ?? null,
    address: raw.address ?? null,
    city: raw.city ?? 'München',
    organizer: raw.promoter ?? null,
    source_url: raw.url ?? null,
    image_url: null,
    latitude: null,
    longitude: null,
  };
}

async function main() {
  console.log('Resident Advisor collector stub started — implement fetch/scrape.');
  const supabase = createClient(OUR_SUPABASE_URL, OUR_SERVICE_ROLE_KEY);
  const normalizedEvents: any[] = [];

  if (normalizedEvents.length === 0) {
    console.log('No events fetched (stub).');
    return;
  }

  const { error } = await supabase.from('events').upsert(normalizedEvents, { onConflict: 'source_id' });
  if (error) {
    console.error('Fehler beim Speichern:', error);
    process.exit(1);
  }

  console.log(`${normalizedEvents.length} Events gespeichert/aktualisiert.`);
}

main();
