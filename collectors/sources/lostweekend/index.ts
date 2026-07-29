import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';
import { fileURLToPath } from 'url';
import { getCoordinates } from '../../core/geocode';
import { extractJsonLdEvents } from '../../core/scrape';

const EVENTS_PAGE_URL = 'https://lostweekend.de/events/';
const USER_AGENT = 'VibeApp-EventAggregator/1.0 (München Event-Aggregator, nicht-kommerziell)';

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
  image: string | null;
  description: string | null;
}

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

// Preis steht nicht auf der Übersichtsseite (article.mec-event-article), nur
// auf der Event-Detailseite als schema.org Event mit offers.price/priceCurrency
// (per Direktabruf verifiziert, 2026-07) — braucht einen Zusatzabruf pro Event.
function formatPriceInfo(raw: string | null): string | null {
  if (!raw) return null;
  const match = raw.match(/^(ab\s+)?([\d.,]+)\s*([A-Z]{3})$/i);
  if (!match) return raw;
  const [, prefix, amountStr, currency] = match;
  const amount = Number(amountStr.replace(',', '.'));
  if (Number.isNaN(amount)) return raw;
  if (amount === 0) return 'Kostenlos';
  try {
    const formatted = new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(amount);
    return prefix ? `ab ${formatted}` : formatted;
  } catch {
    return raw;
  }
}

async function fetchLostWeekendPriceInfo(eventUrl: string): Promise<string | null> {
  try {
    const res = await fetch(eventUrl, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);
    const [event] = extractJsonLdEvents($);
    return formatPriceInfo(event?.priceInfo ?? null);
  } catch {
    return null;
  } finally {
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function fetchLostWeekendEvents(): Promise<RawEvent[]> {
  const response = await fetch(EVENTS_PAGE_URL, {
    headers: {
      'User-Agent': USER_AGENT,
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

    const classAttr = article.attr('class') ?? '';
    const monthMatch = classAttr.match(/mec-toggle-(\d{4})(\d{2})-/);
    if (!monthMatch) return;
    const year = parseInt(monthMatch[1], 10);
    const month = parseInt(monthMatch[2], 10);

    const titleLink = article.find('.mec-event-title a');
    const title = titleLink.text().trim();
    const url = titleLink.attr('href');
    const eventId = titleLink.attr('data-event-id');

    const dayLabel = article.find('.mec-start-date-label').text().trim();
    const dayMatch = dayLabel.match(/^(\d+)/);
    if (!dayMatch || !title || !url || !eventId) return;
    const day = parseInt(dayMatch[1], 10);

    const rawTime = article.find('.mec-start-time').text().trim();
    const time = rawTime ? convertTo24h(rawTime) : null;

    const locationName =
      article.find('.mec-venue-details > span').first().text().trim() || 'Lost Weekend';
    const address = article.find('.mec-event-address span').text().trim() || null;
    const image = article.find('.mec-event-image img').first().attr('src') || null;
    const description = article.find('.mec-event-description').first().text().trim() || null;

    events.push({ eventId, title, url, year, month, day, time, locationName, address, image, description });
  });

  return events;
}

async function normalizeEvent(raw: RawEvent, supabase: ReturnType<typeof createClient>) {
  const startDate = `${raw.year}-${String(raw.month).padStart(2, '0')}-${String(
    raw.day
  ).padStart(2, '0')}`;

  const coords = await getCoordinates(supabase, raw.locationName, raw.address, 'München');
  const price_info = await fetchLostWeekendPriceInfo(raw.url);

  return {
    // eventId allein reicht nicht als Schlüssel: MEC (das Kalender-Plugin von
    // lostweekend.de) vergibt bei wiederkehrenden Terminen dieselbe eventId für
    // jedes Datum — ohne startDate im source_id würden alle bis auf einen
    // Termin beim Dedup-Map in normalizeEvents kollabieren.
    source_id: `lostweekend-${raw.eventId}-${startDate}`,
    title: raw.title,
    description: raw.description,
    category: 'Kultur',
    subcategory: null,
    start_date: startDate,
    start_time: raw.time,
    location_name: raw.locationName,
    address: raw.address,
    city: 'München',
    organizer: 'Lost Weekend',
    source_url: raw.url,
    image_url: raw.image,
    price_info,
    latitude: coords?.latitude ?? null,
    longitude: coords?.longitude ?? null,
  };
}

export async function run() {
  console.log('Lost-Weekend-Collector gestartet...');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[lostweekend] missing supabase envs — skipping'); return; }

  const rawEvents = await fetchLostWeekendEvents();
  console.log(`${rawEvents.length} Events auf der Seite gefunden`);

  const today = new Date().toISOString().slice(0, 10);
  const supabase = createClient(supabaseUrl, supabaseKey);

  // Vor dem (jetzt teureren, da pro Event ein Preis-Zusatzabruf nötig ist)
  // Normalisieren nach Zukunft filtern, um keine Requests für vergangene
  // Events zu verschwenden.
  const upcomingRawEvents = rawEvents.filter((event) => {
    const startDate = `${event.year}-${String(event.month).padStart(2, '0')}-${String(event.day).padStart(2, '0')}`;
    return startDate >= today;
  });
  console.log(`${upcomingRawEvents.length} davon in der Zukunft`);

  const normalizedEvents = [];
  for (const event of upcomingRawEvents) {
    normalizedEvents.push(await normalizeEvent(event, supabase));
  }

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