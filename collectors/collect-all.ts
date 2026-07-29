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
import { run as runMuffathalle } from './sources/muffathalle/index.js';
import { run as runLustspielhaus } from './sources/lustspielhaus/index.js';
import { run as runFatCat } from './sources/fat_cat/index.js';
import { run as runDeutschesTheater } from './sources/deutsches_theater/index.js';
import { run as runGaertnerplatztheater } from './sources/gaertnerplatztheater/index.js';
import { run as runKomoedieBayerischerHof } from './sources/komoedie_bayerischer_hof/index.js';
import { run as runMuffatwerk } from './sources/muffatwerk/index.js';
import { run as runPasingerFabrik } from './sources/pasinger_fabrik/index.js';
import { run as runWerkhaus } from './sources/werkhaus/index.js';
import { run as runOktoberfestEvents } from './sources/oktoberfest_events/index.js';
import { run as runEintrittfreiMuenchen } from './sources/eintrittfrei_muenchen/index.js';

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
// - messe-muenchen: die Firmen-Startseite (/veranstaltungskalender/) ist nur
//   eine Übersichtsseite ohne Termine; der echte Kalender
//   (/de/veranstaltungen/?event-calendar_y=2026) lädt seine Messeliste über
//   <script type="module">-Web-Components (components.messe-muenchen.de,
//   Stencil/Angular) nach — im Server-HTML steht kein einziger Messename
//   oder Termin. Gleiches Muster wie eventfrog/billetto/ampere/lmu, kein
//   Konfigurationsfehler (verifiziert 2026-07).
//
// bahnwaerter-thiel scrapt seit 2026-07 nicht mehr in-muenchen.de, sondern
// die eigene Homepage (bahnwaerterthiel.de) direkt — die dortige
// in-muenchen.de-Locationseite lieferte nur 0-1 Events, während die eigene
// Seite 33 echte, datierte Events auf einer einzigen Anfrage liefert (kein
// gemeinsamer Host, also auch keine Drossel-Pause nötig).
//
// Hinweis zu in-muenchen.de-basierten Quellen (p1, muenchen-de, feierwerk,
// rote-sonne, technikum, gasteig-hp8, unter-deck, blitz-club, tonhalle,
// volkstheater, residenztheater): Lauf vom 2026-07-29
// (Commit 8743e52) lieferte nur von blitz-club (1) und residenztheater (1)
// überhaupt Events, alle anderen 0 — trotz direkt verifizierter, echter
// Event-Daten auf jeder einzelnen Seite. Der Code ist also nicht das
// Problem. Wahrscheinlichste Ursache: in-muenchen.de blockt oder drosselt
// GitHub Actions' Cloud-IP-Bereiche, verstärkt durch den Burst von 12
// Quellen, die kurz hintereinander denselben Host treffen (milla zeigte
// früher schon einmal einen klaren 403 aus GH Actions, siehe
// Commit-Historie). Als Gegenmaßnahme bekommen alle Quellen mit
// gemeinsamem host-Tag eine deutlich längere Pause (4s statt 750ms)
// zueinander — ob das reicht, zeigt sich erst am nächsten echten Lauf.
// host markiert Quellen, die denselben Ziel-Host treffen — genutzt, um
// zwischen zwei Abrufen desselben Hosts eine deutlich längere Pause
// einzulegen als sonst (siehe runAll()). 12 Quellen treffen alle
// in-muenchen.de; hintereinander mit nur 750ms Pause sieht das exakt wie
// eine Scraping-Burst-Sequenz aus, was die beobachtete Unzuverlässigkeit
// in der Produktion (siehe Kommentar oben) erklären könnte.
// UPDATE 2026-07-29: auch nach der 4s-Pause liefern die in-muenchen.de-
// Quellen in Produktion weiterhin fast nur 0 Events (Live-Datenstand
// geprüft: nur blitz-club und residenztheater mit je 1 Event, alle
// anderen — inkl. muenchen-de — komplett leer), während ein direkter
// Abruf derselben Seiten von einem normalen (nicht-GH-Actions-)Rechner aus
// weiterhin anstandslos funktioniert (200, echte Events im HTML). Das
// bestätigt die Verdachtsdiagnose: es ist ein IP-Reputationsblock gegen
// GitHub-Actions-Cloud-IPs, kein Code- oder Timing-Problem, das durch mehr
// Pause allein lösbar wäre. Echte Optionen wären ein Self-Hosted Runner
// (eigener, nicht geblockter Rechner/NAS führt den Workflow aus) oder ein
// bezahlter Residential-Proxy-Dienst — beides eine bewusste Entscheidung,
// die der Projektinhaber treffen muss, nicht etwas, das sich im Code allein
// beheben lässt.
const sources: { name: string; run: () => Promise<void>; host?: string }[] = [
  { name: 'backstage', run: runBackstage },
  { name: 'muenchenticket', run: runMuenchenticket },
  { name: 'lostweekend', run: runLostweekend },
  { name: 'muenchenevent', run: runMuenchenevent },
  { name: 'import-export', run: runImportExport },
  { name: 'milla', run: runMilla },
  { name: 'auer-dult', run: runAuerDult },
  { name: 'flohmarkt-olympiapark', run: runFlohmarktOlympiapark },
  { name: 'hofflohmarkt', run: runHofflohmarkt },
  { name: 'glockenbachwerkstatt', run: runGlockenbachwerkstatt },
  { name: 'oktoberfest-events', run: runOktoberfestEvents },
  { name: 'eintrittfrei-muenchen', run: runEintrittfreiMuenchen },
  // Alle folgenden nutzen dieselbe verifizierte in-muenchen.de-Locationseiten-
  // Extraktion wie p1/muenchen-de (extractInMuenchenTeasers) — eigene
  // Programmseiten der Venues sind JS-gerendert oder nicht scrapbar.
  { name: 'p1', run: runP1, host: 'in-muenchen.de' },
  { name: 'muenchen-de', run: runMuenchenDe, host: 'in-muenchen.de' },
  { name: 'feierwerk', run: runFeierwerk, host: 'in-muenchen.de' },
  { name: 'rote-sonne', run: runRoteSonne, host: 'in-muenchen.de' },
  { name: 'technikum', run: runTechnikum, host: 'in-muenchen.de' },
  { name: 'gasteig-hp8', run: runGasteigHp8, host: 'in-muenchen.de' },
  { name: 'unter-deck', run: runUnterDeck, host: 'in-muenchen.de' },
  { name: 'bahnwaerter-thiel', run: runBahnwaerterThiel },
  { name: 'blitz-club', run: runBlitzClub, host: 'in-muenchen.de' },
  { name: 'tonhalle', run: runTonhalle, host: 'in-muenchen.de' },
  { name: 'volkstheater', run: runVolkstheater, host: 'in-muenchen.de' },
  { name: 'residenztheater', run: runResidenztheater, host: 'in-muenchen.de' },
  { name: 'muffathalle', run: runMuffathalle, host: 'in-muenchen.de' },
  { name: 'lustspielhaus', run: runLustspielhaus, host: 'in-muenchen.de' },
  { name: 'fat-cat', run: runFatCat, host: 'in-muenchen.de' },
  { name: 'deutsches-theater', run: runDeutschesTheater, host: 'in-muenchen.de' },
  { name: 'gaertnerplatztheater', run: runGaertnerplatztheater, host: 'in-muenchen.de' },
  { name: 'komoedie-bayerischer-hof', run: runKomoedieBayerischerHof, host: 'in-muenchen.de' },
  { name: 'muffatwerk', run: runMuffatwerk, host: 'in-muenchen.de' },
  { name: 'pasinger-fabrik', run: runPasingerFabrik, host: 'in-muenchen.de' },
  { name: 'werkhaus', run: runWerkhaus, host: 'in-muenchen.de' },
];

async function runAll() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const envPath = existsSync(path.resolve(__dirname, '.env'))
    ? path.resolve(__dirname, '.env')
    : path.resolve(__dirname, '../app/.env');
  config({ path: envPath });
  console.log('[collect-all] starting run for', sources.length, 'sources');

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    console.log(`[collect-all] running ${source.name}`);
    try {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      await source.run();
    } catch (err) {
      console.error('[collect-all] error running', source.name, err);
    }
    const next = sources[i + 1];
    const sameHost = Boolean(source.host && next?.host === source.host);
    await wait(sameHost ? 4000 : 750);
  }

  console.log('[collect-all] finished');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runAll().catch((e) => { console.error(e); process.exit(1); });
}

export default runAll;
