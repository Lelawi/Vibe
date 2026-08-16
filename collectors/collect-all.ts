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
import { run as runMinnaThiel } from './sources/minna_thiel/index.js';
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
import { run as runEventim } from './sources/eventim/index.js';
import { run as runWannda } from './sources/wannda/index.js';
import { run as runKinoMondSterne } from './sources/kino_mond_sterne/index.js';
import { run as runTheatron } from './sources/theatron/index.js';
import { run as runMuenchenStadtportal } from './sources/muenchen_stadtportal/index.js';
import { run as runMeinestadt } from './sources/meinestadt/index.js';
import { run as runKindaling } from './sources/kindaling/index.js';
import { run as runEventbrite } from './sources/eventbrite/index.js';
import { run as runLieberScholli } from './sources/lieber_scholli/index.js';
import { run as runRausgegangen } from './sources/rausgegangen/index.js';
import { run as runResidentAdvisor } from './sources/resident_advisor/index.js';

async function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

// Nicht enthalten (bewusst, siehe jeweilige Kommentare in den Source-Dateien):
// - bars/restaurants/spaetis: befüllen die separate "venues"-Tabelle (nicht
//   "events"), nicht diesen Lauf — Öffnungszeiten ändern sich selten, ein
//   eigener wöchentlicher Workflow (.github/workflows/collect-venues.yml)
//   reicht statt 2x täglich.
// - meetup, ticketmaster, facebook-events: benötigen kostenpflichtige/
//   OAuth-gebundene API-Keys, die hier nicht konfiguriert sind. eventbrite
//   war früher hier gelistet -- die offizielle API stimmt, aber die
//   öffentlichen Browse-Seiten sind scrapbar, siehe eigener Kommentar unten.
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
// rote-sonne, technikum, gasteig-hp8, unter-deck, tonhalle,
// volkstheater, residenztheater): Lauf vom 2026-07-29
// (Commit 8743e52) lieferte nur von residenztheater (1) sowie der inzwischen
// entfernten Quelle blitz-club (1)
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
// geprüft: nur residenztheater sowie die inzwischen entfernte Quelle
// blitz-club mit je 1 Event, alle
// anderen — inkl. muenchen-de — komplett leer), während ein direkter
// Abruf derselben Seiten von einem normalen (nicht-GH-Actions-)Rechner aus
// weiterhin anstandslos funktioniert (200, echte Events im HTML). Das
// spricht für einen IP-Reputationsblock gegen GitHub-Actions-Cloud-IPs.
// Diese Quellen bleiben deshalb best effort. Netzwerk-Umgehungen, Proxys
// oder Tunnel sind ausdrücklich keine zulässige Lösung für dieses Projekt.
// muenchen-stadtportal (2026-08): offizielles Stadtportal muenchen.de, NICHT
// dasselbe wie die vielen in-muenchen.de-basierten Quellen unten (privates
// Magazin). Eigene stadtweite Veranstaltungsdatenbank mit echtem schema.org-
// Microdata im Server-HTML. Deckt bewusst nur Nicht-Musik-Rubriken ab
// (Theater, Comedy/Kabarett, Ausstellungen, Familie/Kinder, Märkte,
// Weihnachtsmarkt, Feste) — Konzerte/Rock/HipHop/Klassik etc. lässt es aus,
// weil eventim/backstage/muenchenticket die schon abdecken. Details siehe
// Kommentare in sources/muenchen_stadtportal/index.ts.
// meinestadt (2026-08): veranstaltungen.meinestadt.de, aggregiert selbst aus
// vielen Quellen (eventim, kindaling.de, eventfrog u.a.) mit sauberem
// schema.org-Event-JSON-LD. robots.txt sperrt die echte Pagination
// (?curDatesPage=/?allDatesPage=), deshalb wie beim Stadtportal über
// mehrere Kategorie-Pfade statt Seitenzahlen abgedeckt — "konzerte" aus
// demselben Grund ausgelassen. Details siehe sources/meinestadt/index.ts.
// kindaling (2026-08): kindaling.de, Kinderkurse/Ferienprogramme/Familien-
// Events — eine Nische, die sonst nirgends abgedeckt ist. robots.txt
// erlaubt /veranstaltungen/muenchen inkl. ?page=-Pagination explizit.
// Termine (inkl. wiederkehrender Wochenmärkte via eventSchedule) stecken
// nur auf den Einzelseiten, daher 1 Request pro Event zusätzlich zu den
// Listing-Seiten. Details siehe sources/kindaling/index.ts.
// lieber-scholli (2026-08): lieberscholli.de selbst hat keine eigene
// Programmseite mehr, sondern bettet nur noch ein Ticketshop-Widget einer
// eigenen Subdomain ein (lieberscholli.ticket.io, "shop-legacy"). Diese
// Subdomain liefert echtes schema.org-JSON-LD pro Event (Preis, Adresse,
// Geo-Koordinaten inklusive) im Server-HTML, robots.txt erlaubt
// uneingeschränkt. Kein eigener host-Tag, da ticket.io von keiner anderen
// Quelle hier genutzt wird. Details siehe sources/lieber_scholli/index.ts.
// rausgegangen (2026-08): rausgegangen.de, München-Techno-Tag-Seite.
// robots.txt erlaubt Crawler ausdrücklich (auch ClaudeBot, nur mit
// Crawl-Delay). Serverseitig gerenderte Event-Kacheln mit
// stabilen data-testid-Attributen statt JSON-LD (das JSON-LD dort ist nur
// eine URL-Liste ohne Datum/Preis/Location). Nur die erste, ohne Scroll
// geladene Seite (~27 Events) ist erreichbar. Details siehe
// sources/rausgegangen/index.ts.
// eventbrite (2026-08): eventbrite.de. Die offizielle Event-Search-API ist
// seit Februar 2020 für Drittanbieter abgeschaltet, robots.txt sperrt aber
// weder die öffentlichen Kategorie-Browse-Seiten noch liefern die leeres
// JS-Grundgerüst wie eventfrog/billetto — echtes schema.org-JSON-LD inkl.
// Geo-Koordinaten direkt im Server-HTML. ?page=N wird ignoriert (immer
// dieselbe erste Seite), daher wie bei meinestadt über mehrere
// Kategorie-Pfade statt Seitenzahlen abgedeckt. Preise stehen nicht im
// Listing, nur auf den Einzelseiten -- dafür 1 zusätzlicher Request pro
// Event (gleicher Tradeoff wie bei kindaling). Details siehe
// sources/eventbrite/index.ts.
// resident-advisor (2026-08): nutzt nach bestätigter schriftlicher Erlaubnis
// des Projektinhabers direkt ra.co/graphql für München (area=151). Kein
// API-Key, Proxy, Headless-Browser oder kostenpflichtiger Drittanbieter nötig;
// 90 Tage werden mit pageSize=50 und kurzer Pause paginiert. Eventliste und
// Detailfelder kommen gemeinsam pro Seite, also kein N+1-Request je Event.
// HTML/DataDome wird nicht umgangen. Details und Tests siehe
// sources/resident_advisor/index.ts.
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
  { name: 'eventim', run: runEventim, host: 'public-api.eventim.com' },
  { name: 'wannda', run: runWannda },
  { name: 'kino-mond-sterne', run: runKinoMondSterne },
  { name: 'theatron', run: runTheatron },
  { name: 'muenchen-stadtportal', run: runMuenchenStadtportal, host: 'www.muenchen.de' },
  { name: 'meinestadt', run: runMeinestadt, host: 'veranstaltungen.meinestadt.de' },
  { name: 'kindaling', run: runKindaling, host: 'www.kindaling.de' },
  { name: 'eventbrite', run: runEventbrite, host: 'www.eventbrite.de' },
  { name: 'lieber-scholli', run: runLieberScholli },
  { name: 'rausgegangen', run: runRausgegangen, host: 'rausgegangen.de' },
  { name: 'resident-advisor', run: runResidentAdvisor, host: 'ra.co' },
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
  { name: 'minna-thiel', run: runMinnaThiel },
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
