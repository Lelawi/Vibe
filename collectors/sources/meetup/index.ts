import { createClient } from '@supabase/supabase-js';
import { getCoordinates } from '../../core/geocode';

const OUR_SUPABASE_URL = process.env.SUPABASE_URL!;
const OUR_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// TODO: Implement Meetup API client (requires API key / OAuth)
async function normalizeEvent(raw: any, supabase: ReturnType<typeof createClient>) {
  return {
    source_id: `meetup-${raw.id}`,
    title: raw.name ?? 'Unnamed',
    description: raw.description ?? null,
    category: raw.group?.category?.name ?? 'Sonstiges',
    subcategory: null,
    start_date: raw.local_date ?? null,
    start_time: raw.local_time ?? null,
    location_name: raw.venue?.name ?? null,
    address: raw.venue?.address_1 ?? null,
    city: raw.venue?.city ?? 'München',
    organizer: raw.group?.name ?? null,
    source_url: raw.link ?? null,
    image_url: null,
    latitude: null,
    longitude: null,
  };
}

async function main() {
  console.log('Meetup collector stub started — implement API fetch.');
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
