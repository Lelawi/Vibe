import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMillaHomepage } from './index.js';

test('liest Milla-Eventkarten mit Monat, Datum, Uhrzeit, Link und Bild', () => {
  const html = `
    <section class="events">
      <div class="section__header">August 2026</div>
      <div class="columns">
        <div class="column event">
          <a class="event__thumbnail" href="https://milla-club.de/evening-elephants/">
            <img src="https://milla-club.de/files/evening.png">
          </a>
          <div class="columns is-gapless"><div class="column is-date">Aug 19</div><div class="column">Wed 19.00</div></div>
          <div class="event__title"><a href="https://milla-club.de/evening-elephants/"><h3 title="Evening Elephants">Evening Elephants <span>Evening Elephants</span></h3></a></div>
        </div>
      </div>
    </section>`;

  assert.deepEqual(parseMillaHomepage(html), [{
    title: 'Evening Elephants',
    link: 'https://milla-club.de/evening-elephants/',
    start_date: '2026-08-19',
    start_time: '19:00',
    image_url: 'https://milla-club.de/files/evening.png',
  }]);
});

test('ignoriert unbekannte Monatsüberschriften und unvollständige Karten', () => {
  const html = '<section class="events"><div class="section__header">Termine</div><div class="columns"><div class="event"></div></div></section>';
  assert.deepEqual(parseMillaHomepage(html), []);
});
