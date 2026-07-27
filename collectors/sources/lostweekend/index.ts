import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';

const OUR_SUPABASE_URL = process.env.SUPABASE_URL!;
const OUR_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const EVENTS_PAGE_URL = 'https://lostweekend.de/events/';

interface RawEvent {
  eventId: string;
  title: string;
  url: string;
  year: number;
  month: number;
  day: number;
  time: string | null;
  locationName: string;
  address: string | null;
}

// Wandelt "7:00 pm" in "19:00" um
function convertTo24h(timeStr: string): string | null {
  const match = timeStr.match(/(\d+):(\d+)\s*(am|pm)/i);
  if (!match) return null;
  let hour = parseInt(match[1], 10);
  const minute = match[2];
  const meridiem = match[3].toLowerCase();
  if (meridiem === 'pm' && hour !== 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${minute}`;
}

async function fetchLostWeekendEvents(): Promise<RawEvent[]> {
  const response = await fetch(EVENTS_PAGE_URL, {
    headers: {
      'User-Agent': 'VibeApp-EventAggregator/1.0 (München Event-Aggregator, nicht-kommerziell)',
    },
  });

  if (!response.ok) {
    throw new Error(`Lost Weekend Website antwortete mit Status ${response.status}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);
  const events: RawEvent[] = [];

  $('article.mec-event-article').each((_, el) => {
    const article = $(el);

    // Jahr/Monat stecken in der Klasse, z.B. "mec-toggle-202607-966"
    const classAttr = article.attr('class') ?? '';
    const monthMatch = classAttr.match(/mec-toggle-(\d{4})(\d{2})-/);
    if (!monthMatch) return;
    const year = parseInt(monthMatch[1], 10);
    const month = parseInt(monthMatch[2], 10);

    const titleLink = article.find('.mec-event-title a');
    const title = titleLink.text().trim();
    const url = titleLink.attr('href');
    const eventId = titleLink.attr('data-event-id');

    const dayLabel = article.find('.mec-start-date-label').text().trim(); // "30 Jul"
    const dayMatch = dayLabel.match(/^(\d+)/);
    if (!dayMatch || !title || !url || !eventId) return;
    const day = parseInt(dayMatch[1], 10);

    const rawTime = article.find('.mec-start-time').text().trim();
    const time = rawTime ? convertTo24h(rawTime) : null;

    const locationName =
      article.find('.mec-venue-details > span').first().text().trim() || 'Lost Weekend';
    const address = article.find('.mec-event-address span').text().trim() || null;

    events.push({ eventId, title, url, year, month, day, time, locationName, address });
  });

  return events;
}

function normalizeEvent(raw: RawEvent) {
  const startDate = `${raw.year}-${String(raw.month).padStart(2, '0')}-${String(
    raw.day
  ).padStart(2, '0')}`;

  return {
    source_id: `lostweekend-${raw.eventId}`,
    title: raw.title,
    description: null,
    category: 'Kultur',
    subcategory: null,
    start_date: startDate,
    start_time: raw.time,
    location_name: raw.locationName,
    address: raw.address,
    city: 'München',
    organizer: 'Lost Weekend',
    source_url: raw.url,
    image_url: null,
  };
}

async function main() {
  console.log('Lost-Weekend-Collector gestartet...');

  const rawEvents = await fetchLostWeekendEvents();
  console.log(`${rawEvents.length} Events auf der Seite gefunden`);

  const today = new Date().toISOString().slice(0, 10);
  const normalizedEvents = rawEvents
    .map(normalizeEvent)
    .filter((e) => e.start_date >= today);
  console.log(`${normalizedEvents.length} davon in der Zukunft`);

  // Duplikate innerhalb derselben Charge entfernen
  const deduplicatedMap = new Map(normalizedEvents.map((e) => [e.source_id, e]));
  const deduplicatedEvents = Array.from(deduplicatedMap.values());

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