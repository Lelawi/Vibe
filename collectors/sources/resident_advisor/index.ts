import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { linkStructuredArtists } from '../../core/artists';
import { getCoordinates } from '../../core/geocode';
import { dedupeBySourceId } from '../../core/scrape';

const GRAPHQL_URL = 'https://ra.co/graphql';
const MUNICH_AREA_ID = 151;
const PAGE_SIZE = 50;
const HORIZON_DAYS = 90;
const REQUEST_SPACING_MS = 750;

const EVENT_LISTINGS_QUERY = `
  query VibeMunichEvents($filters: FilterInputDtoInput, $page: Int, $pageSize: Int) {
    eventListings(filters: $filters, page: $page, pageSize: $pageSize) {
      data {
        event {
          id
          title
          date
          startTime
          endTime
          content
          cost
          minimumAge
          contentUrl
          venue { id name address }
          artists { name }
          genres { name }
          promoters { name }
          images { filename type }
        }
      }
      totalResults
    }
  }
`;

export interface ResidentAdvisorEvent {
  id?: string;
  title?: string;
  date?: string;
  startTime?: string;
  endTime?: string | null;
  content?: string | null;
  cost?: string | null;
  minimumAge?: number | null;
  contentUrl?: string;
  venue?: { id?: string; name?: string; address?: string | null } | null;
  artists?: Array<{ name?: string }>;
  genres?: Array<{ name?: string }>;
  promoters?: Array<{ name?: string }>;
  images?: Array<{ filename?: string; type?: string }>;
}

interface GraphqlResponse {
  data?: {
    eventListings?: {
      data?: Array<{ event?: ResidentAdvisorEvent | null }>;
      totalResults?: number;
    };
  };
  errors?: Array<{ message?: string }>;
}

interface HttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

type Fetcher = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<HttpResponse>;

const defaultFetcher: Fetcher = (url, init) => fetch(url, init) as Promise<HttpResponse>;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

// Die RA-Zeitstempel enthalten lokale Münchner Uhrzeiten ohne Offset. Nicht
// über new Date() in UTC umrechnen, da sich sonst je nach Runner-Zeitzone das
// angezeigte Datum oder die Uhrzeit verschiebt.
function raDateTime(value: string | null | undefined): { date: string; time: string } | null {
  if (!value) return null;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
  if (!match || Number.isNaN(Date.parse(`${match[1]}T${match[2]}:${match[3]}:00Z`))) return null;
  return { date: match[1], time: `${match[2]}:${match[3]}` };
}

function priceInfo(cost: string | null | undefined): string | null {
  const value = cost?.replace(/\s+/g, ' ').trim();
  if (!value) return null;
  return /^(?:free|frei|0(?:[.,]0+)?\s*€?)$/i.test(value) ? 'Kostenlos' : value;
}

export function normalizeResidentAdvisorEvent(event: ResidentAdvisorEvent) {
  const start = raDateTime(event.startTime ?? event.date);
  const end = raDateTime(event.endTime);
  const id = event.id?.trim();
  const title = event.title?.replace(/\s+/g, ' ').trim();
  const locationName = event.venue?.name?.replace(/\s+/g, ' ').trim();
  if (!id || !/^\d+$/.test(id) || !title || !start || !locationName) return null;

  const contentUrl = event.contentUrl?.trim();
  const sourceUrl = contentUrl && /^\/events\/\d+(?:[/?#].*)?$/.test(contentUrl)
    ? new URL(contentUrl, 'https://ra.co').toString()
    : `https://ra.co/events/${id}`;
  const genres = (event.genres ?? []).map((item) => item.name?.trim()).filter(Boolean) as string[];
  const promoters = (event.promoters ?? []).map((item) => item.name?.trim()).filter(Boolean) as string[];
  const flyer = event.images?.find((item) => item.type === 'FLYERFRONT' && item.filename)?.filename
    ?? event.images?.find((item) => item.filename)?.filename
    ?? null;
  const descriptionParts = [event.content?.trim() || null];
  if (Number.isInteger(event.minimumAge) && event.minimumAge! > 0) {
    descriptionParts.push(`Mindestalter: ${event.minimumAge} Jahre`);
  }

  return {
    source_id: `resident-advisor-${id}`,
    title,
    description: descriptionParts.filter(Boolean).join('\n\n') || null,
    category: 'Clubs',
    subcategory: genres.join(', ') || 'Elektronische Musik',
    start_date: start.date,
    start_time: start.time,
    end_date: end && end.date !== start.date ? end.date : null,
    location_name: locationName,
    address: event.venue?.address?.replace(/\s*;\s*/g, ', ').trim() || null,
    city: 'München',
    organizer: promoters.join(', ') || null,
    source_url: sourceUrl,
    image_url: flyer,
    price_info: priceInfo(event.cost),
    sold_out: null,
    latitude: null as number | null,
    longitude: null as number | null,
  };
}

export async function collectResidentAdvisorEvents(
  reference = new Date(),
  fetcher: Fetcher = defaultFetcher,
  sleep: (ms: number) => Promise<void> = wait,
  horizonDays = HORIZON_DAYS
): Promise<ResidentAdvisorEvent[]> {
  const from = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate()));
  const variables = {
    filters: {
      areas: { eq: MUNICH_AREA_ID },
      listingDate: {
        gte: `${isoDate(from)}T00:00:00.000Z`,
        lte: `${isoDate(addDays(from, Math.max(1, horizonDays) - 1))}T23:59:59.999Z`,
      },
    },
    page: 1,
    pageSize: PAGE_SIZE,
  };
  const collected: ResidentAdvisorEvent[] = [];
  let totalResults = Number.POSITIVE_INFINITY;
  let seenResults = 0;

  while (seenResults < totalResults) {
    const response = await fetcher(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Referer: 'https://ra.co/events/de/munich',
        'User-Agent': 'VibeApp-Collector/1.0',
      },
      body: JSON.stringify({ query: EVENT_LISTINGS_QUERY, variables }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`RA GraphQL antwortete mit Status ${response.status}${detail ? `: ${detail}` : ''}`);
    }

    const body = await response.json() as GraphqlResponse;
    if (body.errors?.length) {
      throw new Error(`RA GraphQL-Fehler: ${body.errors.map((error) => error.message ?? 'Unbekannt').join('; ')}`);
    }
    const listing = body.data?.eventListings;
    if (!listing || !Array.isArray(listing.data) || typeof listing.totalResults !== 'number') {
      throw new Error('RA GraphQL lieferte ein unerwartetes Antwortformat');
    }
    totalResults = listing.totalResults;
    seenResults += listing.data.length;
    const pageEvents = listing.data.map((item) => item.event).filter(Boolean) as ResidentAdvisorEvent[];
    collected.push(...pageEvents);
    console.log(`[resident-advisor] page ${variables.page}: ${pageEvents.length}/${totalResults}`);
    if (listing.data.length === 0 || seenResults >= totalResults) break;
    variables.page += 1;
    await sleep(REQUEST_SPACING_MS);
  }

  return collected;
}

export async function run() {
  console.log('[resident-advisor] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.log('[resident-advisor] missing supabase envs — skipping');
    return;
  }

  const rawEvents = await collectResidentAdvisorEvents();
  const today = isoDate(new Date());
  const events = dedupeBySourceId(rawEvents
    .map(normalizeResidentAdvisorEvent)
    .filter((event): event is NonNullable<ReturnType<typeof normalizeResidentAdvisorEvent>> =>
      Boolean(event && (event.start_date >= today || (event.end_date && event.end_date >= today)))));
  if (events.length === 0) {
    console.log('[resident-advisor] no valid upcoming events returned');
    return;
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  const coordinates = new Map<string, { latitude: number; longitude: number } | null>();
  for (const event of events) {
    const key = `${event.location_name}|${event.address ?? ''}`;
    if (!coordinates.has(key)) {
      coordinates.set(key, await getCoordinates(supabase, event.location_name, event.address, 'München'));
    }
    const coords = coordinates.get(key);
    event.latitude = coords?.latitude ?? null;
    event.longitude = coords?.longitude ?? null;
  }

  const { error } = await supabase.from('events').upsert(events, { onConflict: 'source_id' });
  if (error) throw error;

  try {
    const lineupBySourceId = new Map(rawEvents.map((event) => [
      `resident-advisor-${event.id}`,
      (event.artists ?? []).map((artist) => artist.name?.trim()).filter(Boolean) as string[],
    ]));
    await linkStructuredArtists(
      supabase,
      events.map((event) => ({
        sourceId: event.source_id,
        names: lineupBySourceId.get(event.source_id) ?? [],
      })),
      'resident-advisor-lineup'
    );
  } catch (artistError) {
    console.warn('[resident-advisor] artist links could not be saved', artistError);
  }

  console.log(`[resident-advisor] ${events.length} events saved/updated`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
}

export default run;
