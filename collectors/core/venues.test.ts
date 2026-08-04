import assert from 'node:assert/strict';
import test from 'node:test';
import { dedupeNearbyVenues, normalizeSchemaOpeningHours } from './venues.js';

test('normalisiert ausgeschriebene englische schema.org-Wochentage', () => {
  assert.equal(
    normalizeSchemaOpeningHours('Monday,Tuesday,Wednesday,Thursday,Friday,Saturday,Sunday 09:00-17:00'),
    'Mo,Tu,We,Th,Fr,Sa,Su 09:00-17:00'
  );
});

test('normalisiert ausgeschriebene deutsche Wochentage unabhängig von Großschreibung', () => {
  assert.equal(
    normalizeSchemaOpeningHours('Montag-FREITAG 10:00-18:00; Samstag 10:00-14:00'),
    'Mo-Fr 10:00-18:00; Sa 10:00-14:00'
  );
});

test('führt doppelte OSM-Nodes am selben Ort zusammen und behält vollständigere Daten', () => {
  const venues = dedupeNearbyVenues([
    {
      osm_id: 12913994303,
      name: 'el Tato',
      address: 'Buttermelcherstraße 9, 80469',
      latitude: 48.1325727,
      longitude: 11.578162,
      website: 'https://el-tato.bar/',
      phone: null,
      opening_hours_raw: null,
    },
    {
      osm_id: 2255943604,
      name: 'el Tato',
      address: 'Buttermelcherstraße 9, 80469 München',
      latitude: 48.1325715,
      longitude: 11.5781652,
      website: 'https://el-tato.bar/',
      phone: '+49 89 123456',
      opening_hours_raw: null,
    },
  ]);

  assert.equal(venues.length, 1);
  assert.equal(venues[0].osm_id, 2255943604);
  assert.equal(venues[0].address, 'Buttermelcherstraße 9, 80469 München');
  assert.equal(venues[0].phone, '+49 89 123456');
});

test('behält gleichnamige Venues an verschiedenen Standorten', () => {
  const venues = dedupeNearbyVenues([
    { osm_id: 1, name: 'Kiosk', address: 'Straße 1', latitude: 48.13, longitude: 11.57 },
    { osm_id: 2, name: 'Kiosk', address: 'Straße 2', latitude: 48.14, longitude: 11.58 },
  ]);
  assert.equal(venues.length, 2);
});
