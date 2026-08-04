import assert from 'node:assert/strict';
import test from 'node:test';
import { artistNamesFromProgramTitle, parseTheatronProgram } from './index';

test('parst einzelne Theatron-Programmkarten mit stabiler Event-ID', () => {
  const html = `
    <html><body>
      <h2>31.7. bis 22.8.2026 | Eintritt frei!</h2>
      <article class="mec-event-article">
        <span class="mec-start-date-label">06. August</span>
        <span class="mec-start-time">20:00</span>
        <div class="mec-event-image"><img src="https://example.test/band.jpg"></div>
        <h4 class="mec-event-title">
          <a data-event-id="5629" href="https://theatron.net/veranstaltungen/bowling-rubber/">
            Bowling Rubber
            <div><span class="mec-event-data-field-value">Indie Pop-Punk</span></div>
          </a>
        </h4>
      </article>
    </body></html>`;

  assert.deepEqual(parseTheatronProgram(html), [{
    externalId: '5629',
    title: 'Bowling Rubber',
    date: '2026-08-06',
    time: '20:00',
    style: 'Indie Pop-Punk',
    url: 'https://theatron.net/veranstaltungen/bowling-rubber/',
    imageUrl: 'https://example.test/band.jpg',
  }]);
});

test('verwirft Karten ohne stabile ID oder valides Datum', () => {
  const html = '<body><p>Programm 2026</p><article class="mec-event-article"><span class="mec-start-date-label">99. August</span><h4 class="mec-event-title"><a href="/x">X</a></h4></article></body>';
  assert.deepEqual(parseTheatronProgram(html), []);
});

test('übernimmt nur konkrete Programmkünstler und keine Festival-Sammeltitel', () => {
  assert.deepEqual(artistNamesFromProgramTitle('Bowling Rubber | Vita'), ['Bowling Rubber', 'Vita']);
  assert.deepEqual(artistNamesFromProgramTitle('Theatron MusikSommer Highlights'), []);
  assert.deepEqual(artistNamesFromProgramTitle('Abschlussfeuerwerk'), []);
});
