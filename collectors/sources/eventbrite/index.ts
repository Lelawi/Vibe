// NICHT in collect-all.ts / im Workflow eingebunden: Eventbrite hat die
// öffentliche Event-Search-API 2020 für Drittanbieter abgeschaltet — es gibt
// keinen freien Weg mehr, München-Events zu durchsuchen. Erst reaktivieren,
// wenn ein Eventbrite-Partnerzugang vorliegt.
import { createClient } from '@supabase/supabase-js';
import { getCoordinates } from '../../core/geocode';

const OUR_SUPABASE_URL = process.env.SUPABASE_URL!;
const OUR_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// TODO: Provide Eventbrite API key via env and implement fetch logic
async function normalizeEvent(raw: any, supabase: ReturnType<typeof createClient>) {
  // Map Eventbrite event fields to shared shape
  return {
    source_id: `eventbrite-${raw.id}`,
    title: raw.name?.text ?? 'Unnamed',
    description: raw.description?.text ?? null,
    category: raw.category_id ?? 'Sonstiges',
    subcategory: null,
    start_date: raw.start?.local?.slice(0, 10) ?? null,
    start_time: raw.start?.local?.slice(11, 16) ?? null,
    location_name: raw.venue?.name ?? null,
    address: raw.venue?.address?.localized_address_display ?? null,
    city: raw.venue?.address?.city ?? 'München',
    organizer: raw.organizer?.name ?? null,
    source_url: raw.url ?? null,
    image_url: raw.logo?.url ?? null,
    latitude: null,
    longitude: null,
  };
}

async function main() {
  console.log('Eventbrite collector stub started — implement API fetch.');
  const supabase = createClient(OUR_SUPABASE_URL, OUR_SERVICE_ROLE_KEY);

  // Placeholder: no remote fetch implemented yet
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
