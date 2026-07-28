import path from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import { run as runBackstage } from './sources/backstage/index.js';
import { run as runMuenchenticket } from './sources/muenchenticket/index.js';
import { run as runLostweekend } from './sources/lostweekend/index.js';
import { run as runMuenchenevent } from './sources/muenchenevent/index.js';
import { run as runEventfrog } from './sources/eventfrog/index.js';
import { run as runTickettailor } from './sources/tickettailor/index.js';
import { run as runBilletto } from './sources/billetto/index.js';
import { run as runImportExport } from './sources/import_export/index.js';
import { run as runTito } from './sources/tito/index.js';
import { run as runP1 } from './sources/p1/index.js';
import { run as runMuenchenDe } from './sources/muenchen_de/index.js';
import { run as runAuerDult } from './sources/auer_dult/index.js';
import { run as runFlohmarktOlympiapark } from './sources/flohmarkt_olympiapark/index.js';
import { run as runHofflohmarkt } from './sources/hofflohmarkt/index.js';

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
// - milla: milla-club.de blockt Anfragen mit 403, auch mit echten Browser-Headern
//   (Chrome-UA, Accept-Language) — echter Bot-Schutz, kein simples UA-Sniffing
// - xing_events: reiner Platzhalter, nie implementiert
const sources = [
  { name: 'backstage', run: runBackstage },
  { name: 'muenchenticket', run: runMuenchenticket },
  { name: 'lostweekend', run: runLostweekend },
  { name: 'muenchenevent', run: runMuenchenevent },
  { name: 'eventfrog', run: runEventfrog },
  { name: 'tickettailor', run: runTickettailor },
  { name: 'billetto', run: runBilletto },
  { name: 'import-export', run: runImportExport },
  { name: 'tito', run: runTito },
  { name: 'p1', run: runP1 },
  { name: 'muenchen-de', run: runMuenchenDe },
  { name: 'auer-dult', run: runAuerDult },
  { name: 'flohmarkt-olympiapark', run: runFlohmarktOlympiapark },
  { name: 'hofflohmarkt', run: runHofflohmarkt },
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
