import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectNextWeekProducts,
  nextCalendarWeekDates,
  normalizeEvent,
  type EventimProduct,
} from './index';

const product = (productId: string, postalCode = '80639'): EventimProduct => ({
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
        city: 'München',
        postalCode,
        geoLocation: { latitude: 48.145, longitude: 11.521 },
      },
    },
  },
});

test('collects next week sequentially, splits busy days, filters, deduplicates and adapts', async () => {
  assert.deepEqual(nextCalendarWeekDates(new Date('2026-07-29T12:00:00Z')), [
    '2026-08-03',
    '2026-08-04',
    '2026-08-05',
    '2026-08-06',
    '2026-08-07',
    '2026-08-08',
    '2026-08-09',
  ]);

  const urls: URL[] = [];
  let activeRequests = 0;
  let maxActiveRequests = 0;
  let rateLimited = true;
  const fetcher = async (url: string) => {
    const parsed = new URL(url);
    urls.push(parsed);
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

    const split = parsed.searchParams.has('time_from');
    const firstDay = parsed.searchParams.get('date_from') === '2026-08-03';
    const products = firstDay
      ? [product('1'), product('2', '80331')]
      : [product('1')];
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        totalResults: firstDay && !split ? 51 : products.length,
        products,
      }),
    };
  };

  const sleeps: number[] = [];
  const result = await collectNextWeekProducts(
    '80639',
    new Date('2026-07-29T12:00:00Z'),
    fetcher,
    async (ms) => { sleeps.push(ms); }
  );

  assert.equal(urls.length, 11);
  assert.equal(maxActiveRequests, 1);
  assert.deepEqual(sleeps, [0]);
  assert.equal(urls.filter((url) => url.searchParams.has('time_from')).length, 3);
  assert.ok(urls.every((url) =>
    url.searchParams.get('date_from') === url.searchParams.get('date_to')
  ));
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
