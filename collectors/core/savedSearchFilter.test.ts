import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesSavedSearch, type SavedSearchCriteria } from './savedSearchFilter';

const event = {
  category: 'Konzerte', subcategory: 'Indie Rock', location_name: 'Backstage Halle',
  start_date: '2026-08-08', end_date: null, price_info: 'Kostenlos', sold_out: false,
};
const criteria: SavedSearchCriteria = {
  categories: ['Konzerte'], genres: ['Pop & Rock'], locations: ['Backstage'],
  dateFilter: 'weekend', freeOnly: true, availableOnly: true,
};

test('verknüpft Dimensionen mit UND und Werte innerhalb einer Dimension mit ODER', () => {
  assert.equal(matchesSavedSearch(event, criteria, '2026-08-04'), true);
  assert.equal(matchesSavedSearch({ ...event, category: 'Comedy' }, criteria, '2026-08-04'), false);
  assert.equal(matchesSavedSearch({ ...event, subcategory: 'Techno' }, criteria, '2026-08-04'), false);
  assert.equal(matchesSavedSearch({ ...event, location_name: 'Muffathalle' }, criteria, '2026-08-04'), false);
  assert.equal(matchesSavedSearch(event, { ...criteria, categories: ['Comedy', 'Konzerte'] }, '2026-08-04'), true);
});

test('leere Suche matcht nie und laufende Mehrtagesevents bleiben sichtbar', () => {
  assert.equal(matchesSavedSearch(event, { categories: [], genres: [], locations: [], dateFilter: 'all', freeOnly: false, availableOnly: true }, '2026-08-04'), false);
  assert.equal(matchesSavedSearch({ ...event, start_date: '2026-08-01', end_date: '2026-08-09' }, { ...criteria, dateFilter: 'today' }, '2026-08-04'), true);
});

test('ausverkaufte und nicht kostenlose Events werden bei aktivem Filter ausgeschlossen', () => {
  assert.equal(matchesSavedSearch({ ...event, sold_out: true }, criteria, '2026-08-04'), false);
  assert.equal(matchesSavedSearch({ ...event, price_info: 'ab 20 €' }, criteria, '2026-08-04'), false);
});
