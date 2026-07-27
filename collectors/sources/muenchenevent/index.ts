import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';
import { getCoordinates } from '../../core/geocode';

const OUR_SUPABASE_URL = process.env.SUPABASE_URL!;
const OUR_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const EVENTS_PAGE_URL = 'https://www.muenchenevent.de/me/veranstaltungen';
const BASE_URL = 'https://www.muenchenevent.de';

interface RawEvent {
  eventId: string;
  title: string;
  url: string;
  isoDateTime: string;
  venue: string;
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

    events.push({ eventId, title, url, isoDateTime, venue });
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
    image_url: null,
    latitude: coords?.latitude ?? null,
    longitude: coords?.longitude ?? null,
  };
}

async function main() {
  console.log('MünchenEvent-Collector gestartet...');

  const rawEvents = await fetchMuenchenEventEvents();
  console.log(`${rawEvents.length} Events auf der Seite gefunden`);

  const today = new Date().toISOString().slice(0, 10);
  const supabase = createClient(OUR_SUPABASE_URL, OUR_SERVICE_ROLE_KEY);

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
    process.exit(1);
  }

  console.log(`${deduplicatedEvents.length} Events gespeichert/aktualisiert.`);
}

main();