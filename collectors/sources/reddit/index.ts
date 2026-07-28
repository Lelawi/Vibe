// NICHT in collect-all.ts / im Workflow eingebunden: Reddit-Posts sind
// Freitext ohne verlässliche Struktur für Titel/Datum/Ort — als "Event"-Quelle
// würde das primär Datenmüll in die events-Tabelle schreiben. Die öffentliche
// r/Munich JSON-API ist zwar erreichbar, aber das Grundproblem ist die fehlende
// Datenstruktur, nicht der Zugriff.
import { createClient } from '@supabase/supabase-js';
import { getCoordinates } from '../../core/geocode';

const OUR_SUPABASE_URL = process.env.SUPABASE_URL!;
const OUR_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Reddit r/Muenchen scraper stub — use Reddit API or Pushshift to collect event posts
async function normalizeEvent(raw: any, supabase: ReturnType<typeof createClient>) {
  return {
    source_id: `reddit-${raw.id}`,
    title: raw.title ?? 'Reddit Event',
    description: raw.selftext ?? null,
    category: 'Community',
    subcategory: null,
    start_date: raw.date ?? null,
    start_time: raw.time ?? null,
    location_name: raw.location ?? null,
    address: null,
    city: 'München',
    organizer: raw.author ?? null,
    source_url: `https://reddit.com${raw.permalink}` ?? null,
    image_url: null,
    latitude: null,
    longitude: null,
  };
}

async function main() {
  console.log('Reddit collector stub started — implement API fetch.');
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
