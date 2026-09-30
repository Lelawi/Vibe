import path from 'path';
import { appendFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
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
import { run as runBangbangConcerts } from './sources/bangbang_concerts/index.js';
import { run as runKocherlball } from './sources/kocherlball/index.js';
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
import { run as runKindaling } from './sources/kindaling/index.js';
import { run as runLieberScholli } from './sources/lieber_scholli/index.js';
import { run as runRausgegangen } from './sources/rausgegangen/index.js';
import { run as runResidentAdvisor } from './sources/resident_advisor/index.js';

async function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

// Nicht enthalten (bewusst, siehe jeweilige Kommentare in den Source-Dateien):
// - meinestadt, eventbrite, tollwood-musikarena: deaktiviert 2026-09-30
//   (Code-Review mit Live-Abruf). meinestadt antwortet mit 403 (Akamai),
//   letzter Write 2026-08-09; eventbrite hat aus GitHub Actions nie etwas
//   geschrieben (nur lokal am 2026-08-08) und liefert inzwischen nur noch 8
//   Events pro Kategorie; tollwood.de steht hinter einer Cloudflare-Managed-
//   Challenge (403 auch für wp-json/Sitemap). Umgehungen sind für dieses
//   Projekt keine Option. Die Quelldateien bleiben für einen späteren
//   Neuversuch liegen.
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
// in-muenchen.de-basierte Quellen (p1, muenchen-de, feierwerk, …): liefen
// Ende Juli fast alle mit 0 Events. Ein damals vermuteter IP-Block gegen
// GitHub Actions war es nicht — Ursache war eine source_id-Kollision
// (behoben in Commit 0ce1404, siehe buildStableSourceId in core/scrape.ts).
// Seit 2026-07-29 schreiben alle täglich (Stand 2026-09-30 per Live-Abruf
// geprüft). Quellen mit gemeinsamem host-Tag bekommen trotzdem eine längere
// Pause zueinander (4s statt 750ms), um den Host nicht per Burst zu treffen.
// muenchen-stadtportal (2026-08): offizielles Stadtportal muenchen.de, NICHT
// dasselbe wie die vielen in-muenchen.de-basierten Quellen unten (privates
// Magazin). Eigene stadtweite Veranstaltungsdatenbank mit echtem schema.org-
// Microdata im Server-HTML. Deckt bewusst nur Nicht-Musik-Rubriken ab
// (Theater, Comedy/Kabarett, Ausstellungen, Familie/Kinder, Märkte,
// Weihnachtsmarkt, Feste) — Konzerte/Rock/HipHop/Klassik etc. lässt es aus,
// weil eventim/backstage/muenchenticket die schon abdecken. Details siehe
// Kommentare in sources/muenchen_stadtportal/index.ts.
// meinestadt (2026-08, seit 2026-09-30 deaktiviert, s.o.): veranstaltungen.meinestadt.de, aggregiert selbst aus
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
// eventbrite (2026-08, seit 2026-09-30 deaktiviert, s.o.): eventbrite.de. Die offizielle Event-Search-API ist
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
// name = source_id-Präfix der Quelle (für die Zählung pro Lauf, siehe
// runAll). seasonal: 0 Zeilen sind außerhalb der Saison normal, keine
// Warnung. timeoutMin: Obergrenze, nach der collect-all mit der nächsten
// Quelle weitermacht, statt dass eine hängende Verbindung (kein fetch hat
// ein eigenes Timeout) den ganzen Lauf blockiert.
type Source = { name: string; run: () => Promise<void>; host?: string; seasonal?: boolean; timeoutMin?: number };
const sources: Source[] = [
  { name: 'backstage', run: runBackstage },
  { name: 'muenchenticket', run: runMuenchenticket },
  { name: 'lostweekend', run: runLostweekend },
  { name: 'muenchenevent', run: runMuenchenevent },
  { name: 'import-export', run: runImportExport },
  { name: 'milla', run: runMilla },
  { name: 'auer-dult', run: runAuerDult, seasonal: true },
  { name: 'flohmarkt-olympiapark', run: runFlohmarktOlympiapark },
  { name: 'hofflohmarkt', run: runHofflohmarkt },
  { name: 'glockenbachwerkstatt', run: runGlockenbachwerkstatt },
  { name: 'oktoberfest-events', run: runOktoberfestEvents, seasonal: true },
  { name: 'eintrittfrei-muenchen', run: runEintrittfreiMuenchen },
  { name: 'eventim', run: runEventim, host: 'public-api.eventim.com', timeoutMin: 35 },
  { name: 'wannda', run: runWannda },
  { name: 'kino-mond-sterne', run: runKinoMondSterne, seasonal: true },
  { name: 'theatron', run: runTheatron, seasonal: true },
  { name: 'muenchen-stadtportal', run: runMuenchenStadtportal, host: 'www.muenchen.de', timeoutMin: 40 },
  { name: 'kindaling', run: runKindaling, host: 'www.kindaling.de' },
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
  { name: 'bangbang-concerts', run: runBangbangConcerts },
  { name: 'kocherlball', run: runKocherlball, seasonal: true },
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

const DEFAULT_TIMEOUT_MIN = 15;

type SourceResult = { name: string; seconds: number; rows: number | null; error: string | null; seasonal: boolean };

function withTimeout<T>(promise: Promise<T>, minutes: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout nach ${minutes} min`)), minutes * 60_000);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runAll(): Promise<number> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const envPath = existsSync(path.resolve(__dirname, '.env'))
    ? path.resolve(__dirname, '.env')
    : path.resolve(__dirname, '../app/.env');
  config({ path: envPath });
  console.log('[collect-all] starting run for', sources.length, 'sources');

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;
  const runStartedAt = new Date().toISOString();
  const results: SourceResult[] = [];

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    console.log(`[collect-all] running ${source.name}`);
    const startedAt = new Date();
    let error: string | null = null;
    try {
      await withTimeout(source.run(), source.timeoutMin ?? DEFAULT_TIMEOUT_MIN);
    } catch (err) {
      console.error('[collect-all] error running', source.name, err);
      error = err instanceof Error ? err.message : String(err);
    }

    // Wie viele Zeilen hat die Quelle in diesem Lauf geschrieben? Jeder
    // Insert/Upsert setzt source_checked_at (Default bzw. Trigger aus 0030),
    // und seit 0049 fasst Dedup das Feld nicht mehr an — die Zählung ist
    // damit ein verlässliches "hat die Quelle geliefert?"-Signal, ohne dass
    // jede der ~45 Quellen dafür umgebaut werden muss. Vorher fiel eine
    // Quelle, die still 0 Events lieferte, niemandem auf (milla, meinestadt,
    // eventbrite, bahnwaerter-thiel wochenlang).
    let rows: number | null = null;
    if (supabase) {
      const { count, error: countError } = await supabase
        .from('events')
        .select('id', { count: 'exact', head: true })
        .like('source_id', `${source.name}-%`)
        .gte('source_checked_at', startedAt.toISOString());
      if (countError) console.warn('[collect-all] counting rows failed for', source.name, countError);
      else rows = count ?? 0;
    }
    const seconds = Math.round((Date.now() - startedAt.getTime()) / 1000);
    results.push({ name: source.name, seconds, rows, error, seasonal: Boolean(source.seasonal) });
    console.log(`[collect-all] ${source.name}: ${rows ?? '?'} Zeilen, ${seconds}s${error ? `, Fehler: ${error}` : ''}`);

    const next = sources[i + 1];
    const sameHost = Boolean(source.host && next?.host === source.host);
    await wait(sameHost ? 4000 : 750);
  }

  const problems = results.filter((r) => r.error || (r.rows === 0 && !r.seasonal));
  for (const r of problems) {
    // GitHub-Annotation: erscheint als Warnung am Workflow-Lauf, ohne ihn
    // rot zu machen (keine tägliche Fehlermail, nur weil EINE Seite blockt).
    console.log(`::warning title=Quelle ${r.name}::${r.error ? `Fehler: ${r.error}` : '0 Zeilen geschrieben'}`);
  }

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    const status = (r: SourceResult) =>
      r.error ? `⚠️ ${r.error.replace(/\|/g, '/').slice(0, 120)}`
      : r.rows === 0 ? (r.seasonal ? 'leer (saisonal)' : '⚠️ 0 Zeilen')
      : 'ok';
    const lines = [
      '## Collector-Lauf',
      '',
      `${results.length} Quellen, ${problems.length} mit Problem.`,
      '',
      '| Quelle | Zeilen | Dauer | Status |',
      '|---|---:|---:|---|',
      ...results.map((r) => `| ${r.name} | ${r.rows ?? '?'} | ${r.seconds}s | ${status(r)} |`),
    ];
    appendFileSync(summaryPath, lines.join('\n') + '\n');
  }

  // Protokoll für den Wochenbericht (Tabelle aus 0053). Fehlt die Tabelle
  // noch (Migration nicht angewendet), nur warnen — der Lauf selbst zählt.
  if (supabase) {
    const { error: logError } = await supabase.from('collector_runs').insert(
      results.map((r) => ({
        run_started_at: runStartedAt,
        source: r.name,
        rows_written: r.rows,
        duration_seconds: r.seconds,
        error: r.error,
        seasonal: r.seasonal,
      }))
    );
    if (logError) console.warn('[collect-all] writing collector_runs failed', logError);
  }

  console.log('[collect-all] finished');
  // Rot nur bei einem systemischen Ausfall (z.B. Supabase nicht erreichbar):
  // einzelne blockierende Quellen stehen als Warnung im Lauf und im
  // Wochenbericht, lösen aber keine tägliche Fehlermail aus.
  const nonSeasonal = results.filter((r) => !r.seasonal);
  const failedShare = nonSeasonal.filter((r) => r.error || r.rows === 0).length / Math.max(1, nonSeasonal.length);
  return failedShare > 0.5 ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Explizit beenden: nach einem Timeout kann eine hängende Verbindung den
  // Prozess sonst bis zum Workflow-Limit offen halten.
  runAll().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
}

export default runAll;
