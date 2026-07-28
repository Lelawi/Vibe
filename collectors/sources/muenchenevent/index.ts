import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';
import { fileURLToPath } from 'url';
import { getCoordinates } from '../../core/geocode';

const EVENTS_PAGE_URL = 'https://www.muenchenevent.de/me/veranstaltungen';
const BASE_URL = 'https://www.muenchenevent.de';

interface RawEvent {
  eventId: string;
  title: string;
  url: string;
  isoDateTime: string;
  venue: string;
  image: string | null;
}

function isoToLocalDateTime(iso: string) {
  const date = new Date(iso);
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

async function fetchMuenchenEventEvents(): Promise<RawEvent[]> {
  const response = await fetch(EVENTS_PAGE_URL, {
    headers: {
      'User-Agent': 'VibeApp-EventAggregator/1.0 (München Event-Aggregator, nicht-kommerziell)',
    },
  });

  if (!response.ok) {
    throw new Error(`MünchenEvent Website antwortete mit Status ${response.status}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);
  const events: RawEvent[] = [];

  $('.event-overview-extended--item').each((_, el) => {
    const item = $(el);

    const isoDateTime = item.find('time').attr('datetime');
    const titleLink = item.find('h3.headline1 a');
    const title = titleLink.text().trim();
    let url = titleLink.attr('href');
    const eventId = item.find('input[name="veranst"]').attr('value');
    const venue =
      item
        .find('.event-overview-extended--item-content--details--time-location h4')
        .first()
        .text()
        .trim() || 'München Event';

    if (!isoDateTime || !title || !url || !eventId) return;

    if (!url.startsWith('http')) {
      url = `${BASE_URL}${url}`;
    }

    // Events ohne eigenes Bild zeigen ein generisches "logo_event_mm.svg"
    // Platzhalterlogo statt eines echten Fotos — das überspringen wir.
    const imgSrc = item
      .find('img')
      .filter((_, im) => !($(im).attr('src') || '').includes('logo_event_mm'))
      .first()
      .attr('src');
    const image = imgSrc ? (imgSrc.startsWith('http') ? imgSrc : `${BASE_URL}${imgSrc}`) : null;

    events.push({ eventId, title, url, isoDateTime, venue, image });
  });

  return events;
}

async function normalizeEvent(raw: RawEvent, supabase: ReturnType<typeof createClient>) {
  const { date, time } = isoToLocalDateTime(raw.isoDateTime);
  const coords = await getCoordinates(supabase, raw.venue, null, 'München');

  return {
    source_id: `muenchenevent-${raw.eventId}`,
    title: raw.title,
    description: null,
    category: 'Konzerte',
    subcategory: null,
    start_date: date,
    start_time: time,
    location_name: raw.venue,
    address: null,
    city: 'München',
    organizer: 'MünchenEvent',
    source_url: raw.url,
    image_url: raw.image,
    latitude: coords?.latitude ?? null,
    longitude: coords?.longitude ?? null,
  };
}

export async function run() {
  console.log('MünchenEvent-Collector gestartet...');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[muenchenevent] missing supabase envs — skipping'); return; }

  const rawEvents = await fetchMuenchenEventEvents();
  console.log(`${rawEvents.length} Events auf der Seite gefunden`);

  const today = new Date().toISOString().slice(0, 10);
  const supabase = createClient(supabaseUrl, supabaseKey);

  const normalizedEvents = [];
  for (const event of rawEvents) {
    const normalized = await normalizeEvent(event, supabase);
    if (normalized.start_date >= today) {
      normalizedEvents.push(normalized);
    }
  }
  console.log(`${normalizedEvents.length} davon in der Zukunft`);

  const deduplicatedMap = new Map(normalizedEvents.map((e) => [e.source_id, e]));
  const deduplicatedEvents = Array.from(deduplicatedMap.values());

  const { error } = await supabase
    .from('events')
    .upsert(deduplicatedEvents, { onConflict: 'source_id' });

  if (error) {
    console.error('Fehler beim Speichern:', error);
    return;
  }

  console.log(`${deduplicatedEvents.length} Events gespeichert/aktualisiert.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

export default run;