import { createClient } from '@supabase/supabase-js';
import { getCoordinates } from '../../core/geocode';

/**
 * Ticketmaster collector (template)
 * - Prefer using Ticketmaster Discovery API (requires API key) over scraping.
 * - Environment variables: `TICKETMASTER_API_KEY` (if used), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
 * - Respect rate limits and check TOS before enabling.
 */

const OUR_SUPABASE_URL = process.env.SUPABASE_URL ?? null;
const OUR_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? null;
const TICKETMASTER_API_KEY = process.env.TICKETMASTER_API_KEY ?? null;

export async function run() {
  console.log('[ticketmaster] starting (placeholder)');
  if (!TICKETMASTER_API_KEY) {
    console.log('[ticketmaster] no TICKETMASTER_API_KEY set — skipping active fetch.');
    return;
  }
  const supabase = createClient(OUR_SUPABASE_URL!, OUR_SERVICE_ROLE_KEY!);

  const pageSize = 100;
  let page = 0;
  let totalPages = 1;
  const eventsToUpsert: any[] = [];

  while (page < totalPages) {
    const url = new URL('https://app.ticketmaster.com/discovery/v2/events.json');
    url.searchParams.set('apikey', TICKETMASTER_API_KEY!);
    url.searchParams.set('city', 'Munich');
    url.searchParams.set('size', String(pageSize));
    url.searchParams.set('page', String(page));

    console.log(`[ticketmaster] fetching page ${page}`);
    const res = await fetch(url.toString());
    if (!res.ok) {
      console.error('[ticketmaster] API error', res.status, await res.text());
      break;
    }

    const body = await res.json();
    const pageInfo = body.page ?? { totalPages: 0 };
    totalPages = pageInfo.totalPages ?? 0;

    const items: any[] = (body._embedded && body._embedded.events) || [];

    for (const item of items) {
      const id = item.id;
      const title = item.name ?? 'Unbenannt';
      const startDateTime = item.dates?.start?.dateTime ?? null;
      let start_date = null;
      let start_time = null;
      if (startDateTime) {
        const d = new Date(startDateTime);
        start_date = d.toISOString().slice(0, 10);
        start_time = d.toISOString().slice(11, 16);
      }

      const classifications = item.classifications ?? [];
      const category = classifications[0]?.segment?.name ?? 'Sonstiges';
      const subcategory = classifications.map((c: any) => c.genre?.name).filter(Boolean).join(', ') || null;

      const venue = (item._embedded && item._embedded.venues && item._embedded.venues[0]) || null;
      const location_name = venue?.name ?? null;
      const addressParts = [];
      if (venue?.address?.line1) addressParts.push(venue.address.line1);
      if (venue?.city?.name) addressParts.push(venue.city.name);
      if (venue?.state?.name) addressParts.push(venue.state.name);
      if (venue?.postalCode) addressParts.push(venue.postalCode);
      const address = addressParts.length ? addressParts.join(', ') : null;

      // Geocode (may return null)
      const coords = await getCoordinates(supabase, location_name ?? title, address, 'München');

      eventsToUpsert.push({
        source_id: `ticketmaster-${id}`,
        title,
        description: item.info ?? item.pleaseNote ?? null,
        category,
        subcategory,
        start_date,
        start_time,
        location_name,
        address,
        city: venue?.city?.name ?? 'München',
        organizer: item.promoter?.name ?? null,
        source_url: item.url ?? null,
        image_url: (item.images && item.images[0]?.url) ?? null,
        latitude: coords?.latitude ?? null,
        longitude: coords?.longitude ?? null,
      });
    }

    page += 1;

    // Be polite: small delay between pages
    await new Promise((r) => setTimeout(r, 500));
  }

  if (eventsToUpsert.length) {
    console.log(`[ticketmaster] upserting ${eventsToUpsert.length} events`);
    const { error } = await supabase.from('events').upsert(eventsToUpsert, { onConflict: 'source_id' });
    if (error) {
      console.error('[ticketmaster] upsert error', error);
    } else {
      console.log('[ticketmaster] upsert complete');
    }
  } else {
    console.log('[ticketmaster] no events collected');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}
