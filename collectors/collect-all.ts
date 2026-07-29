import path from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import { run as runBackstage } from './sources/backstage/index.js';
import { run as runMuenchenticket } from './sources/muenchenticket/index.js';
import { run as runLostweekend } from './sources/lostweekend/index.js';
import { run as runMuenchenevent } from './sources/muenchenevent/index.js';
import { run as runImportExport } from './sources/import_export/index.js';
import { run as runMilla } from './sources/milla/index.js';
import { run as runP1 } from './sources/p1/index.js';
import { run as runMuenchenDe } from './sources/muenchen_de/index.js';
import { run as runAuerDult } from './sources/auer_dult/index.js';
import { run as runFlohmarktOlympiapark } from './sources/flohmarkt_olympiapark/index.js';
import { run as runHofflohmarkt } from './sources/hofflohmarkt/index.js';
import { run as runGlockenbachwerkstatt } from './sources/glockenbachwerkstatt/index.js';
import { run as runFeierwerk } from './sources/feierwerk/index.js';
import { run as runRoteSonne } from './sources/rote_sonne/index.js';
import { run as runTechnikum } from './sources/technikum/index.js';
import { run as runGasteigHp8 } from './sources/gasteig_hp8/index.js';
import { run as runUnterDeck } from './sources/unter_deck/index.js';
import { run as runBahnwaerterThiel } from './sources/bahnwaerter_thiel/index.js';
import { run as runBlitzClub } from './sources/blitz_club/index.js';
import { run as runTonhalle } from './sources/tonhalle/index.js';
import { run as runVolkstheater } from './sources/volkstheater/index.js';
import { run as runResidenztheater } from './sources/residenztheater/index.js';

async function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

// Nicht enthalten (bewusst, siehe jeweilige Kommentare in den Source-Dateien):
// - eventbrite, meetup, ticketmaster, facebook-events: benötigen kostenpflichtige/
//   OAuth-gebundene API-Keys, die hier nicht konfiguriert sind
// - residentadvisor, eventim: keine freie API, starker Bot-Schutz (Cloudflare/SPA)
// - reddit: keine strukturierten Eventdaten, ungeeignet als Quelle
// - kulturserver, tickets_de, sueddeutsche: keine echte/erreichbare München-Quelle
// - tz_az: tz.de/muenchen/veranstaltungen antwortet mit 404, keine funktionierende
//   Nachfolge-URL gefunden (Stand 2026-07)
// - lmu, ampere: Programm wird per JavaScript nachgeladen, im Server-HTML steht
//   nichts — bräuchte einen Headless-Browser (Playwright/Puppeteer), nicht nur fetch+cheerio
// - xing_events: reiner Platzhalter, nie implementiert
// - tickettailor, tito: keine plattformweite München-Suche vorhanden (nur pro
//   Veranstalter eigene Seiten) — ohne kuratierte Liste bekannter Accounts
//   liefern sie strukturell nie Events, daher ganz entfernt statt nur zu skippen
// - eventfrog: eventfrog.de rendert die Event-Liste über eine <efrg-event-search>
//   Web-Component (Angular/Stencil) — im Server-HTML steht kein einziges Datum,
//   die Karten entstehen komplett client-seitig per JS. Wie ampere/lmu: mit
//   fetch+cheerio strukturell nie erreichbar, kein Konfigurationsfehler.
// - billetto: das <script type="application/ld+json"> auf billetto.eu ist nur
//   eine Alpine.js-Vorlage (x-text="event.schema") — der eigentliche JSON-Inhalt
//   wird erst im Browser per JS eingesetzt, im rohen Server-HTML ist das
//   Script-Tag leer. Gleiches Problem wie eventfrog, daher ebenfalls entfernt.
//
// Hinweis zu milla/p1/muenchen-de/glockenbachwerkstatt: Stand 2026-07 liefern
// alle vier in der Produktion (GitHub Actions) 0 Events, obwohl direkte Abrufe
// derselben URLs von einem normalen Nutzer-Netz aus einwandfreie, zum Code
// passende Markup/Daten zurückgeben (echte Events, korrektes Datumsformat) —
// der Code ist also nicht das Problem. Wahrscheinlichste Ursache: GitHub
// Actions' Cloud-IP-Bereiche werden von diesen Seiten geblockt oder gedrosselt
// (bei milla bereits einmal als 403 beobachtet, siehe Commit-Historie;
// glockenbachwerkstatt.de war bei einem Testabruf zudem ungewöhnlich langsam
// und lief in ein 30s-Timeout, bevor ein zweiter Versuch klappte). Lässt sich
// ohne Zugriff auf die tatsächlichen GH-Actions-Logs nicht abschließend
// bestätigen — nächster Schritt wäre, den Workflow-Log nach einem Lauf direkt
// zu prüfen.
const sources = [
  { name: 'backstage', run: runBackstage },
  { name: 'muenchenticket', run: runMuenchenticket },
  { name: 'lostweekend', run: runLostweekend },
  { name: 'muenchenevent', run: runMuenchenevent },
  { name: 'import-export', run: runImportExport },
  { name: 'milla', run: runMilla },
  { name: 'p1', run: runP1 },
  { name: 'muenchen-de', run: runMuenchenDe },
  { name: 'auer-dult', run: runAuerDult },
  { name: 'flohmarkt-olympiapark', run: runFlohmarktOlympiapark },
  { name: 'hofflohmarkt', run: runHofflohmarkt },
  { name: 'glockenbachwerkstatt', run: runGlockenbachwerkstatt },
  // Alle folgenden nutzen dieselbe verifizierte in-muenchen.de-Locationseiten-
  // Extraktion wie p1/muenchen-de (extractInMuenchenTeasers) — eigene
  // Programmseiten der Venues sind JS-gerendert oder nicht scrapbar.
  { name: 'feierwerk', run: runFeierwerk },
  { name: 'rote-sonne', run: runRoteSonne },
  { name: 'technikum', run: runTechnikum },
  { name: 'gasteig-hp8', run: runGasteigHp8 },
  { name: 'unter-deck', run: runUnterDeck },
  { name: 'bahnwaerter-thiel', run: runBahnwaerterThiel },
  { name: 'blitz-club', run: runBlitzClub },
  { name: 'tonhalle', run: runTonhalle },
  { name: 'volkstheater', run: runVolkstheater },
  { name: 'residenztheater', run: runResidenztheater },
];

async function runAll() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const envPath = existsSync(path.resolve(__dirname, '.env'))
    ? path.resolve(__dirname, '.env')
    : path.resolve(__dirname, '../app/.env');
  config({ path: envPath });
  console.log('[collect-all] starting run for', sources.length, 'sources');

  for (const source of sources) {
    console.log(`[collect-all] running ${source.name}`);
    try {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      await source.run();
    } catch (err) {
      console.error('[collect-all] error running', source.name, err);
    }
    await wait(750);
  }

  console.log('[collect-all] finished');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runAll().catch((e) => { console.error(e); process.exit(1); });
}

export default runAll;
