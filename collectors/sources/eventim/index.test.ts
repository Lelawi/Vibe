import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectUpcomingProducts,
  berlinToday,
  normalizeEvent,
  normalizeEventimTitle,
  type EventimProduct,
} from './index';

const product = (productId: string, city = 'München'): EventimProduct => ({
  productId,
  productGroupId: `group-${productId}`,
  name: `Event ${productId}`,
  link: `https://www.eventim.de/event/${productId}`,
  price: 19.9,
  currency: 'EUR',
  status: 'Available',
  inStock: true,
  categories: [
    { name: 'Konzerte' },
    { name: 'Rock & Pop', parentCategory: { name: 'Konzerte' } },
  ],
  typeAttributes: {
    liveEntertainment: {
      startDate: `2026-08-0${productId}T20:00:00+02:00`,
      endDate: `2026-08-0${productId}T22:00:00+02:00`,
      location: {
        name: 'Backstage München',
        city,
        postalCode: '80331',
        geoLocation: { latitude: 48.145, longitude: 11.521 },
      },
    },
  },
});

const okResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => body,
});

test('recursively splits busy date ranges, falls back to time windows, filters, deduplicates and adapts', async () => {
  assert.equal(
    berlinToday(new Date('2026-07-29T12:00:00Z')).toISOString().slice(0, 10),
    '2026-07-29'
  );

  const urls: URL[] = [];
  let activeRequests = 0;
  let maxActiveRequests = 0;
  let rateLimited = true;
  const requestHeaders: Record<string, string>[] = [];
  const fetcher = async (url: string, init: { headers: Record<string, string> }) => {
    const parsed = new URL(url);
    urls.push(parsed);
    requestHeaders.push(init.headers);
    activeRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    await Promise.resolve();
    activeRequests -= 1;

    if (rateLimited) {
      rateLimited = false;
      return {
        ok: false,
        status: 429,
        headers: { get: () => '0' },
        json: async () => ({}),
      };
    }

    const dateFrom = parsed.searchParams.get('date_from');
    const dateTo = parsed.searchParams.get('date_to');
    const hasTimeWindow = parsed.searchParams.has('time_from');

    // Gesamter Horizont (3 Tage, per horizonDays-Parameter im Test verkürzt) —
    // "überfüllt", erzwingt eine Halbierung in Tag 1 / Tag 2-3.
    if (dateFrom === '2026-07-29' && dateTo === '2026-07-31' && !hasTimeWindow) {
      return okResponse({ totalResults: 100, products: [] });
    }
    // Tag 1 allein weiterhin "überfüllt" -> Tageszeit-Fenster-Fallback.
    if (dateFrom === '2026-07-29' && dateTo === '2026-07-29' && !hasTimeWindow) {
      return okResponse({ totalResults: 60, products: [] });
    }
    if (dateFrom === '2026-07-29' && dateTo === '2026-07-29' && hasTimeWindow) {
      const timeFrom = parsed.searchParams.get('time_from');
      if (timeFrom === '00:00') return okResponse({ totalResults: 1, products: [product('1')] });
      if (timeFrom === '12:00') return okResponse({ totalResults: 1, products: [product('2', 'Augsburg')] });
      return okResponse({ totalResults: 0, products: [] });
    }
    // Tag 2-3 zusammen unter TOP -> keine weitere Aufteilung nötig, liefert
    // dieselbe productId wie oben erneut (testet Dedup über den ganzen Lauf).
    if (dateFrom === '2026-07-30' && dateTo === '2026-07-31' && !hasTimeWindow) {
      return okResponse({ totalResults: 1, products: [product('1')] });
    }

    throw new Error(`unexpected request: ${url}`);
  };

  const sleeps: number[] = [];
  const result = await collectUpcomingProducts(
    new Date('2026-07-29T12:00:00Z'),
    fetcher,
    async (ms) => { sleeps.push(ms); },
    3
  );

  assert.equal(urls.length, 7);
  assert.match(requestHeaders[0]['User-Agent'], /Mozilla/);
  assert.equal(requestHeaders[0].Referer, 'https://www.eventim.de/');
  assert.equal(maxActiveRequests, 1);
  assert.deepEqual(sleeps, [0]);
  assert.equal(urls.filter((url) => url.searchParams.has('time_from')).length, 3);
  assert.deepEqual(result.map((item) => item.productId), ['1']);

  const normalized = normalizeEvent(result[0]);
  assert.deepEqual(normalized, {
    source_id: 'eventim-1',
    title: 'Event 1',
    description: null,
    category: 'Konzerte',
    subcategory: 'Rock & Pop',
    start_date: '2026-08-01',
    start_time: '20:00',
    end_date: '2026-08-01',
    location_name: 'Backstage München',
    address: null,
    city: 'München',
    organizer: null,
    source_url: 'https://www.eventim.de/event/1',
    image_url: null,
    price_info: 'ab 19,90 €',
    sold_out: false,
    latitude: 48.145,
    longitude: 11.521,
  });
  assert.equal(normalizeEvent({ ...result[0], price: undefined })?.price_info, null);
});

test('erhält Ticketvarianten für die gemeinsame Darstellung am Event', () => {
  assert.equal(normalizeEventimTitle('Jurassic World: The Experience - Premium-Ticket'), 'Jurassic World: The Experience - Premium-Ticket');
  assert.equal(normalizeEventimTitle('Jurassic World: The Experience – VIP & Extras'), 'Jurassic World: The Experience – VIP & Extras');
  assert.equal(normalizeEventimTitle('VIP Club Night'), 'VIP Club Night');
});

test('behandelt ein datiertes Zeitfensterticket nicht als Monats-Dauerevent', () => {
  const timeSlot = product('1');
  timeSlot.name = 'Jurassic World: The Experience';
  timeSlot.link = 'https://www.eventim.de/event/jurassic-world-the-experience-zeitfenstertickets-kleine-olympiahalle-21062334/';
  timeSlot.typeAttributes!.liveEntertainment!.endDate = '2026-08-31T18:00:00+02:00';

  assert.equal(normalizeEvent(timeSlot)?.end_date, null);
});
