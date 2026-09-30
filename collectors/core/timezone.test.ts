import assert from 'node:assert/strict';
import test from 'node:test';
import { berlinToday, berlinWallClockToDate, isoToBerlinWallClock, resolveYearlessDate } from './timezone';

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

test('berlinToday nutzt Berliner Datum auch kurz nach Mitternacht', () => {
  // 30.09. 22:30 UTC = 01.10. 00:30 in Berlin (CEST)
  assert.equal(berlinToday(new Date('2026-09-30T22:30:00Z')), '2026-10-01');
});

test('resolveYearlessDate: heutiger Termin bleibt im laufenden Jahr', () => {
  assert.equal(resolveYearlessDate(9, 30, new Date('2026-09-30T15:00:00Z')), '2026-09-30');
});

test('resolveYearlessDate: kürzlich vergangener Termin wird nicht ins Folgejahr geschoben', () => {
  assert.equal(resolveYearlessDate(9, 20, new Date('2026-09-30T15:00:00Z')), '2026-09-20');
});

test('resolveYearlessDate: Januar-Termin im Dezember-Listing gehört ins Folgejahr', () => {
  assert.equal(resolveYearlessDate(1, 5, new Date('2026-12-10T12:00:00Z')), '2027-01-05');
});

test('resolveYearlessDate: ungültige Tage liefern null', () => {
  assert.equal(resolveYearlessDate(2, 31, new Date('2026-01-10T12:00:00Z')), null);
});

test('isoToBerlinWallClock rechnet UTC-Zeitstempel in Berliner Wandzeit um', () => {
  assert.deepEqual(isoToBerlinWallClock('2026-10-01T18:00:00Z'), { date: '2026-10-01', time: '20:00' });
  assert.deepEqual(isoToBerlinWallClock('2026-12-01T19:30:00.000Z'), { date: '2026-12-01', time: '20:30' });
});

test('isoToBerlinWallClock: Offset-Zeitstempel über Mitternacht bekommt das Berliner Datum', () => {
  assert.deepEqual(isoToBerlinWallClock('2026-10-01T22:30:00Z'), { date: '2026-10-02', time: '00:30' });
});

test('isoToBerlinWallClock übernimmt Zeitstempel ohne Offset wörtlich', () => {
  assert.deepEqual(isoToBerlinWallClock('2026-10-01T20:00:00'), { date: '2026-10-01', time: '20:00' });
  assert.deepEqual(isoToBerlinWallClock('2026-10-01'), { date: '2026-10-01', time: null });
  assert.deepEqual(isoToBerlinWallClock('2026-10-01T20:00:00+02:00'), { date: '2026-10-01', time: '20:00' });
});
