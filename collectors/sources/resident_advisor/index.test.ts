import assert from 'node:assert/strict';
import test from 'node:test';
import { collectResidentAdvisorEvents, normalizeResidentAdvisorEvent } from './index';

const rawEvent = {
  id: '2503504',
  title: '  Beispielnacht  ',
  date: '2026-08-15T00:00:00.000',
  startTime: '2026-08-15T23:00:00.000',
  endTime: '2026-08-16T06:00:00.000',
  content: 'Techno in München',
  cost: '15€',
  minimumAge: 18,
  contentUrl: '/events/2503504',
  venue: { id: '123', name: 'Blitz', address: 'Museumsinsel 1; 80538 Munich; Germany' },
  artists: [{ name: 'DJ Eins' }, { name: 'DJ Zwei' }],
  genres: [{ name: 'Techno' }, { name: 'House' }],
  promoters: [{ name: 'Kollektiv' }],
  images: [{ filename: 'https://example.test/back.jpg', type: 'FLYERBACK' }, { filename: 'https://example.test/front.jpg', type: 'FLYERFRONT' }],
};

test('normalisiert die strukturierten RA-Felder für die events-Tabelle', () => {
  assert.deepEqual(normalizeResidentAdvisorEvent(rawEvent), {
    source_id: 'resident-advisor-2503504',
    title: 'Beispielnacht',
    description: 'Techno in München\n\nMindestalter: 18 Jahre',
    category: 'Clubs',
    subcategory: 'Techno, House',
    start_date: '2026-08-15',
    start_time: '23:00',
    end_date: '2026-08-16',
    location_name: 'Blitz',
    address: 'Museumsinsel 1, 80538 Munich, Germany',
    city: 'München',
    organizer: 'Kollektiv',
    source_url: 'https://ra.co/events/2503504',
    image_url: 'https://example.test/front.jpg',
    price_info: '15€',
    sold_out: null,
    latitude: null,
    longitude: null,
  });
});

test('verwirft Einträge ohne stabile ID, Venue oder valides Datum', () => {
  assert.equal(normalizeResidentAdvisorEvent({ ...rawEvent, id: 'abc' }), null);
  assert.equal(normalizeResidentAdvisorEvent({ ...rawEvent, venue: null }), null);
  assert.equal(normalizeResidentAdvisorEvent({ ...rawEvent, startTime: 'kein Datum' }), null);
});

test('paginiert sparsam und sendet München sowie den Datumsbereich', async () => {
  const requests: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  const sleeps: number[] = [];
  const pages = [
    { data: Array.from({ length: 50 }, (_, index) => ({ event: { ...rawEvent, id: String(index + 1) } })), totalResults: 51 },
    { data: [{ event: { ...rawEvent, id: '51' } }], totalResults: 51 },
  ];
  const result = await collectResidentAdvisorEvents(
    new Date('2026-08-12T12:00:00Z'),
    async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body), headers: init.headers });
      const page = pages[requests.length - 1];
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { eventListings: page } }),
        text: async () => '',
      };
    },
    async (ms) => { sleeps.push(ms); },
    30
  );

  assert.equal(result.length, 51);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://ra.co/graphql');
  assert.equal(requests[0].headers['User-Agent'], 'VibeApp-Collector/1.0');
  assert.deepEqual(requests[0].body.variables, {
    filters: {
      areas: { eq: 151 },
      listingDate: {
        gte: '2026-08-12T00:00:00.000Z',
        lte: '2026-09-10T23:59:59.999Z',
      },
    },
    page: 1,
    pageSize: 50,
  });
  assert.equal(requests[1].body.variables.page, 2);
  assert.deepEqual(sleeps, [750]);
});

test('meldet GraphQL-Fehler auch bei HTTP 200', async () => {
  await assert.rejects(
    collectResidentAdvisorEvents(new Date('2026-08-12T12:00:00Z'), async () => ({
      ok: true,
      status: 200,
      json: async () => ({ errors: [{ message: 'Schema geändert' }] }),
      text: async () => '',
    })),
    /Schema geändert/
  );
});
