import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { getCoordinates } from '../../core/geocode';

const PROGRAM_URL = 'https://theatron.net/mec_calendars/theatron-programm/';
const LOCATION = 'Theatron im Olympiapark';

const MONTHS: Record<string, number> = {
  januar: 1, februar: 2, märz: 3, april: 4, mai: 5, juni: 6,
  juli: 7, august: 8, september: 9, oktober: 10, november: 11, dezember: 12,
};

export type TheatronEvent = {
  externalId: string;
  title: string;
  date: string;
  time: string | null;
  style: string | null;
  url: string;
  imageUrl: string | null;
};

function isoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return null;
  return date.toISOString().slice(0, 10);
}

export function parseTheatronProgram(html: string): TheatronEvent[] {
  const $ = cheerio.load(html);
  const pageText = $('body').text();
  const year = Number(pageText.match(/\b(20\d{2})\b/)?.[1]);
  if (!year) return [];

  const events: TheatronEvent[] = [];
  $('article.mec-event-article').each((_, article) => {
    const root = $(article);
    const titleLink = root.find('.mec-event-title a[data-event-id]').first();
    const externalId = titleLink.attr('data-event-id')?.trim();
    const title = titleLink.clone().children().remove().end().text().replace(/\s+/g, ' ').trim();
    const url = titleLink.attr('href')?.trim();
    const rawDate = root.find('.mec-start-date-label').first().text().trim();
    const dateMatch = rawDate.match(/(\d{1,2})\.\s*([A-Za-zÄÖÜäöü]+)/);
    const month = dateMatch ? MONTHS[dateMatch[2].toLowerCase()] : undefined;
    const date = dateMatch && month ? isoDate(year, month, Number(dateMatch[1])) : null;
    if (!externalId || !title || !url || !date) return;

    const rawTime = root.find('.mec-start-time').first().text().trim();
    const timeMatch = rawTime.match(/(\d{1,2}):(\d{2})/);
    const style = root.find('.mec-event-data-field-value').first().text().replace(/\s+/g, ' ').trim() || null;
    events.push({
      externalId,
      title,
      date,
      time: timeMatch ? `${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}` : null,
      style,
      url,
      imageUrl: root.find('.mec-event-image img').first().attr('src')?.trim() || null,
    });
  });
  return events;
}

export async function run() {
  console.log('[theatron] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[theatron] missing supabase envs — skipping'); return; }

  const response = await fetch(PROGRAM_URL, {
    headers: { 'User-Agent': 'VibeApp-Collector/1.0', Accept: 'text/html,application/xhtml+xml' },
  });
  if (!response.ok) throw new Error(`Theatron-Programm antwortete mit Status ${response.status}`);
  const events = parseTheatronProgram(await response.text());
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = events.filter((event) => event.date >= today);
  if (upcoming.length === 0) { console.log('[theatron] no upcoming program items parsed'); return; }

  const supabase = createClient(supabaseUrl, supabaseKey);
  const coords = await getCoordinates(supabase, LOCATION, null, 'München');
  const rows = upcoming.map((event) => ({
    source_id: `theatron-${event.externalId}-${event.date}`,
    title: event.title,
    description: event.style,
    category: 'Konzerte',
    subcategory: event.style,
    start_date: event.date,
    start_time: event.time,
    end_date: null,
    location_name: LOCATION,
    address: null,
    city: 'München',
    organizer: 'Theatron MusikSommer',
    source_url: event.url,
    image_url: event.imageUrl,
    price_info: 'Kostenlos',
    sold_out: false,
    latitude: coords?.latitude ?? null,
    longitude: coords?.longitude ?? null,
  }));

  const { error } = await supabase.from('events').upsert(rows, { onConflict: 'source_id' });
  if (error) throw error;

  // Die beiden bisherigen Quellen liefern nur ein Festival-Gesamtevent bzw.
  // generische Wochentermine. Erst nach erfolgreichem Speichern der echten
  // Slots entfernen, damit ein temporärer Seitenfehler keine Datenlücke
  // erzeugt. Die Abfrage ist eng auf genau diesen Titel und diese Quellen
  // begrenzt.
  const { data: aggregateRows, error: aggregateFetchError } = await supabase
    .from('events')
    .select('id,source_id')
    .ilike('title', 'theatron musik%sommer%');
  if (aggregateFetchError) {
    console.warn('[theatron] could not find old aggregate rows', aggregateFetchError);
  } else {
    const obsoleteIds = (aggregateRows ?? [])
      .filter((row) => /^(eintrittfrei-muenchen|muenchen-de)-/.test(row.source_id ?? ''))
      .map((row) => row.id as string);
    if (obsoleteIds.length > 0) {
      const { error: deleteError } = await supabase.from('events').delete().in('id', obsoleteIds);
      if (deleteError) console.warn('[theatron] could not remove old aggregate rows', deleteError);
      else console.log(`[theatron] removed ${obsoleteIds.length} old aggregate row(s)`);
    }
  }
  console.log(`[theatron] ${rows.length} program items saved/updated`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
}

export default run;
