import assert from 'node:assert/strict';
import test from 'node:test';
import { googleOpeningHoursToOsm } from './index.js';

test('normalisiert gleiche Zeiten an allen Wochentagen', () => {
  const periods = Array.from({ length: 7 }, (_, day) => ({
    open: { day, hour: 9, minute: 0 },
    close: { day, hour: 17, minute: 0 },
  }));
  assert.equal(googleOpeningHoursToOsm(periods), 'Mo-Su 09:00-17:00');
});

test('erhält Mittagspausen und markiert fehlende Tage als geschlossen', () => {
  const periods = [1, 2, 3, 4, 5].flatMap((day) => [
    { open: { day, hour: 9, minute: 0 }, close: { day, hour: 12, minute: 0 } },
    { open: { day, hour: 14, minute: 0 }, close: { day, hour: 18, minute: 0 } },
  ]);
  assert.equal(googleOpeningHoursToOsm(periods), 'Mo-Fr 09:00-12:00,14:00-18:00; Sa-Su off');
});

test('normalisiert Mitternacht und durchgehend geöffnete Tage', () => {
  assert.equal(
    googleOpeningHoursToOsm([
      { open: { day: 5, hour: 18, minute: 0 }, close: { day: 6, hour: 0, minute: 0 } },
      { open: { day: 6, hour: 0, minute: 0 } },
    ]),
    'Mo-Th off; Fr 18:00-24:00; Sa 00:00-24:00; Su off'
  );
});

test('verwirft fehlende oder ungültige Perioden', () => {
  assert.equal(googleOpeningHoursToOsm(undefined), null);
  assert.equal(googleOpeningHoursToOsm([{ open: { day: 9, hour: 9, minute: 0 } }]), null);
});
