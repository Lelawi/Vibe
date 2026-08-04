import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSchemaOpeningHours } from './venues.js';

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
