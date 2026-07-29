import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { getCoordinates } from '../../core/geocode';

// Der Flohmarkt im Olympiapark ist kein Einzel-Event, sondern findet (fast)
// jeden Freitag & Samstag statt (7-16 Uhr), organisiert vom BRK München.
// Es gibt keine strukturierte Event-Feed-API dafür — die offizielle Seite
// (olympiapark.de) veröffentlicht stattdessen eine Liste von Ausnahmeterminen
// (Ausfälle wegen Großveranstaltungen), die hier von Hand gepflegt werden muss.
// Quelle für die 2026er Ausnahmen: olympiapark.de/veranstaltungen (Stand 2026-07).
const ADDRESS = 'Spiridon-Louis-Ring 21, 80809 München';
const SOURCE_URL = 'https://www.olympiapark.de/en/events/flea-market-in-the-olympic-park-n3370';
const WEEKS_AHEAD = 8;
const EXCLUDED_DATES_2026 = ['2026-05-30', '2026-06-27', '2026-07-18', '2026-08-15', '2026-08-22', '2026-10-03'];

function nextOccurrences(): string[] {
  const dates: string[] = [];
  const now = new Date();
  for (let i = 0; i < WEEKS_AHEAD * 7 + 7; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    const weekday = d.getDay(); // 5 = Freitag, 6 = Samstag
    if (weekday === 5 || weekday === 6) {
      const iso = d.toISOString().slice(0, 10);
      if (!EXCLUDED_DATES_2026.includes(iso)) dates.push(iso);
    }
  }
  return dates;
}

export async function run() {
  console.log('[flohmarkt-olympiapark] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[flohmarkt-olympiapark] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const coords = await getCoordinates(supabase, 'Flohmarkt Olympiapark', ADDRESS, 'München');

  const collected = nextOccurrences().map((start_date) => ({
    source_id: `flohmarkt-olympiapark-${start_date}`,
    title: 'Flohmarkt im Olympiapark',
    description: 'Freitag & Samstag 7-16 Uhr auf dem Sapporobogen-Gelände, organisiert vom BRK München.',
    category: 'Märkte',
    subcategory: 'Flohmarkt',
    start_date,
    start_time: '07:00',
    location_name: 'Olympiapark München',
    address: ADDRESS,
    city: 'München',
    organizer: 'BRK Kreisverband München',
    source_url: SOURCE_URL,
    image_url: null,
    // Wie bei Flohmärkten üblich zahlen nur Standbetreiber eine Standgebühr,
    // der Eintritt für Besuchende ist frei.
    price_info: 'Kostenlos',
    latitude: coords?.latitude ?? null,
    longitude: coords?.longitude ?? null,
  }));

  console.log('[flohmarkt-olympiapark] upserting', collected.length, 'events');
  const { error } = await supabase.from('events').upsert(collected, { onConflict: 'source_id' });
  if (error) console.error('[flohmarkt-olympiapark] upsert error', error);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

export default run;
