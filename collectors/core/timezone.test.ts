import assert from 'node:assert/strict';
import test from 'node:test';
import { berlinWallClockToDate } from './timezone';

test('rechnet Sommerzeit (CEST, UTC+2) korrekt in UTC um', () => {
  const date = berlinWallClockToDate('2026-08-13', '20:00:00');
  assert.equal(date.toISOString(), '2026-08-13T18:00:00.000Z');
});

test('rechnet Winterzeit (CET, UTC+1) korrekt in UTC um', () => {
  const date = berlinWallClockToDate('2026-01-13', '20:00:00');
  assert.equal(date.toISOString(), '2026-01-13T19:00:00.000Z');
});

test('funktioniert auch mit HH:MM statt HH:MM:SS', () => {
  const date = berlinWallClockToDate('2026-08-13', '20:00');
  assert.equal(date.toISOString(), '2026-08-13T18:00:00.000Z');
});
