import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { getCoordinates } from '../../core/geocode';
import { buildStableSourceId, dedupeBySourceId } from '../../core/scrape';

// Bahnwärter Thiel hat entgegen einer früheren Annahme doch eine eigene,
// serverseitig gerenderte Programmseite (bahnwaerterthiel.de, per
// Direktabruf verifiziert 2026-07: 36 Events über Juni-August auf einer
// einzigen Seite) — die in-muenchen.de-Locationseite lieferte dagegen nur
// 0-1 Events, da sie diese kleinere Location kaum pflegt. Direkt von der
// eigenen Seite ist also sowohl vollständiger als auch schneller (kein
// Umweg + Drossel-Pause über den gemeinsamen in-muenchen.de-Host).
//
// Markup (kein JSON-LD, reines Text-Parsing): jedes Event steckt in
// <label class="events-toggle">Wochentag DD.MM.YYYY – HH-HH Uhr<br>Titel
// <p>Lineup-Zeile<br>...</p></label> — Datum/Zeit und Titel stehen direkt
// im Label-Text (vor dem verschachtelten <p>), das Lineup im <p> selbst.
const HOMEPAGE_URL = 'https://bahnwaerterthiel.de/';
const ADDRESS = 'Tumblingerstraße 45, 80337 München';

// Zwei Zeitformate kommen auf der Seite vor: "DD.MM.YYYY – HH-HH Uhr" für die
// meisten Partys, aber "DD.MM.YYYY – Einlass: HH:MM / HH:MM-HH:MM Uhr" für
// Programm mit festem Beginn (z.B. Poetry Slam) — dort zählt die
// Einlasszeit als start_time, nicht die spätere Programmzeit.
const DATE_TIME_PATTERN =
  /(?<day>\d{1,2})\.(?<month>\d{1,2})\.(?<year>\d{4})\s*[–-]?\s*(?:Einlass:\s*(?<einlassHour>\d{1,2}):(?<einlassMinute>\d{2})\s*\/\s*\d{1,2}(?::\d{2})?\s*-\s*\d{1,2}(?::\d{2})?\s*Uhr|(?<hour>\d{1,2})(?::(?<minute>\d{2}))?\s*-\s*\d{1,2}(?::\d{2})?\s*Uhr)/;
const WEEKDAY_PREFIX = /^(Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag)\s*/;

export async function run() {
  console.log('[bahnwaerter_thiel] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[bahnwaerter_thiel] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const collected: any[] = [];
  const today = new Date().toISOString().slice(0, 10);

  try {
    console.log('[bahnwaerter_thiel] fetching', HOMEPAGE_URL);
    const res = await fetch(HOMEPAGE_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) { console.warn('[bahnwaerter_thiel] fetch failed', res.status); return; }
    const html = await res.text();
    const $ = cheerio.load(html);

    const coords = await getCoordinates(supabase, 'Bahnwärter Thiel', ADDRESS, 'München');

    $('label.events-toggle').each((_, el) => {
      const label$ = $(el);
      const lineup = label$.find('p').first().text().replace(/\s+/g, ' ').trim() || null;
      // Klon ohne das verschachtelte <p>, damit die Lineup-Zeilen nicht in
      // den Datum/Zeit/Titel-Text hineinlaufen.
      const headerText = label$.clone().find('p').remove().end().text().replace(/\s+/g, ' ').trim();

      const match = headerText.match(DATE_TIME_PATTERN);
      if (!match?.groups) return;

      const { day, month, year, einlassHour, einlassMinute, hour, minute } = match.groups;
      const start_date = new Date(Date.UTC(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10)))
        .toISOString()
        .slice(0, 10);
      if (start_date < today) return;
      const startHour = einlassHour ?? hour;
      const startMinute = einlassMinute ?? minute ?? '00';
      const start_time = `${startHour.padStart(2, '0')}:${startMinute}`;

      const title = headerText
        .replace(DATE_TIME_PATTERN, '')
        .replace(WEEKDAY_PREFIX, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!title) return;

      const sourceId = buildStableSourceId('bahnwaerter-thiel', title, start_date);
      collected.push({
        source_id: sourceId,
        title,
        description: lineup,
        category: 'Clubs',
        subcategory: null,
        start_date,
        start_time,
        location_name: 'Bahnwärter Thiel',
        address: ADDRESS,
        city: 'München',
        organizer: 'Bahnwärter Thiel',
        source_url: HOMEPAGE_URL,
        image_url: null,
        price_info: null,
        latitude: coords?.latitude ?? null,
        longitude: coords?.longitude ?? null,
      });
    });
  } catch (err) {
    console.warn('[bahnwaerter_thiel] error', err);
  }

  if (collected.length === 0) { console.log('[bahnwaerter_thiel] no events parsed'); return; }
  console.log('[bahnwaerter_thiel] upserting', collected.length, 'events');
  const { error } = await supabase.from('events').upsert(dedupeBySourceId(collected), { onConflict: 'source_id' });
  if (error) console.error('[bahnwaerter_thiel] upsert error', error);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

export default run;
