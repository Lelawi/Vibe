import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { getCoordinates } from '../../core/geocode';
import { buildStableSourceId, dedupeBySourceId } from '../../core/scrape';

// Minna Thiel, Schwesterbar von Bahnwärter Thiel (selber Betreiber, siehe
// sources/bahnwaerter_thiel — dort verlinkt sogar deren Website noch auf
// bahnwaerterthiel.de auf einigen Verzeichnis-Einträgen), aber eigene
// Adresse (Bernd-Eichinger-Platz 1, 80333 München, Kunstareal) und eigene
// Programmseite unter minnathiel.de/programm — per Nutzer-Feedback gemeldet
// (2026-08-14: "Minna thiel fehlt noch komplett"), der Ort selbst war zu dem
// Zeitpunkt bereits über den generischen bars-Collector (OSM/Overpass) in
// der venues-Tabelle, nur ein Events-Collector fehlte noch.
//
// Anders als bahnwaerterthiel.de (label.events-toggle, kein JSON-LD) nutzt
// minnathiel.de WordPress-Gutenberg-"Details"-Blöcke: jedes Event steckt in
// <details class="wp-block-details ..."><summary>Wochentag, DD.MM.YY,
// HH[-HH] Uhr<br>Titel</summary>...Bild/Beschreibungs-Absätze...</details>
// (per Direktabruf verifiziert, 2026-08: 22 Events über Juli-September auf
// einer einzigen Seite, kein JSON-LD vorhanden).
const PROGRAM_URL = 'https://minnathiel.de/programm/';
const ADDRESS = 'Bernd-Eichinger-Platz 1, 80333 München';

// "Mittwoch, 01.07.26, 20 Uhr" oder "Samstag, 04.07.26, 16-22 Uhr" — die
// zweistellige Jahreszahl (kein "20" vorangestellt) ist auf der Seite
// durchgängig so, keine 4-stellige Variante beobachtet.
const DATE_TIME_PATTERN =
  /(?<day>\d{1,2})\.(?<month>\d{1,2})\.(?<year>\d{2}),?\s*(?<hour>\d{1,2})(?::(?<minute>\d{2}))?(?:-\d{1,2}(?::\d{2})?)?\s*Uhr/;
const WEEKDAY_PREFIX = /^(Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag),?\s*/;

function textFromFragment(html: string): string {
  return cheerio.load(`<div>${html}</div>`)('div').text().replace(/\s+/g, ' ').trim();
}

export async function run() {
  console.log('[minna_thiel] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[minna_thiel] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const collected: any[] = [];
  const today = new Date().toISOString().slice(0, 10);

  try {
    console.log('[minna_thiel] fetching', PROGRAM_URL);
    const res = await fetch(PROGRAM_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) { console.warn('[minna_thiel] fetch failed', res.status); return; }
    const html = await res.text();
    const $ = cheerio.load(html);

    const coords = await getCoordinates(supabase, 'Minna Thiel', ADDRESS, 'München');

    $('details.wp-block-details').each((_, el) => {
      const details$ = $(el);
      const summary$ = details$.find('summary').first();
      const summaryHtml = summary$.html() ?? '';
      const [dateTimePart, ...titleParts] = summaryHtml.split(/<br\s*\/?>/i);

      const dateTimeText = textFromFragment(dateTimePart ?? '');
      const match = dateTimeText.match(DATE_TIME_PATTERN);
      if (!match?.groups) return;

      const { day, month, year, hour, minute } = match.groups;
      const start_date = new Date(Date.UTC(2000 + parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10)))
        .toISOString()
        .slice(0, 10);
      if (start_date < today) return;
      const start_time = `${hour.padStart(2, '0')}:${minute ?? '00'}`;

      const title = textFromFragment(titleParts.join(' '))
        .replace(WEEKDAY_PREFIX, '')
        .trim();
      if (!title) return;

      // Bild und Beschreibung stecken in den <p>-Elementen nach dem summary
      // — das reine Bild-<p> liefert leeren .text(), fällt beim Join also
      // von selbst raus.
      const paragraphs = details$.find('p').map((__, p) => $(p).text().replace(/\s+/g, ' ').trim()).get().filter(Boolean);
      const description = paragraphs.join(' ') || null;
      const imageUrl = details$.find('img').first().attr('src') || null;
      const price_info = description && /eintritt frei/i.test(description) ? 'Eintritt frei' : null;

      const sourceId = buildStableSourceId('minna-thiel', title, start_date);
      collected.push({
        source_id: sourceId,
        title,
        description,
        category: 'Bars',
        subcategory: null,
        start_date,
        start_time,
        location_name: 'Minna Thiel',
        address: ADDRESS,
        city: 'München',
        organizer: 'Minna Thiel',
        source_url: PROGRAM_URL,
        image_url: imageUrl,
        price_info,
        latitude: coords?.latitude ?? null,
        longitude: coords?.longitude ?? null,
      });
    });
  } catch (err) {
    console.warn('[minna_thiel] error', err);
  }

  if (collected.length === 0) { console.log('[minna_thiel] no events parsed'); return; }
  console.log('[minna_thiel] upserting', collected.length, 'events');
  const { error } = await supabase.from('events').upsert(dedupeBySourceId(collected), { onConflict: 'source_id' });
  if (error) console.error('[minna_thiel] upsert error', error);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

export default run;
