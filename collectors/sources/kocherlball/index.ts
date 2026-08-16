import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { getCoordinates } from '../../core/geocode';
import { buildStableSourceId, parseGermanDate } from '../../core/scrape';

// Kocherlball am Chinesischen Turm — Münchner Traditionsfest (seit den
// 1880ern), einmal jährlich Sonntagfrüh (6-10 Uhr) im Englischen Garten,
// kostenlos, ~12.000 Besucher*innen. Per Recherche entdeckt (2026-08-16, im
// Zuge der Bang-Bang!-Suche nach fehlenden Open-Airs) — bislang durch keine
// Quelle abgedeckt.
//
// Nur EIN Termin/Jahr, keine Programmliste zum Scrapen — die offizielle
// Seite (kocherlball.de, eigene Domain des Wirts, kein Aggregator) nennt
// den nächsten Termin ganzjährig im Fließtext (kein JSON-LD), im
// wiederkehrenden Satzmuster "Am <Wochentag>, den <Datum>, verwandelt sich
// der Biergarten am Chinesischen Turm ... von <Start> bis <Ende> Uhr" (per
// Direktabruf 2026-08 verifiziert). Fragiler als ein strukturierter
// Kalender, aber die einzig verfügbare Quelle für dieses Fest; schlägt der
// Satz irgendwann fehl (Formulierung geändert), liefert der Collector
// einfach 0 Events statt eines falschen Termins.
const PAGE_URL = 'https://kocherlball.de/';
const LOCATION = 'Biergarten am Chinesischen Turm';
const ADDRESS = 'Englischer Garten 3, 80538 München';

const DATE_SENTENCE_PATTERN =
  /Am\s+\w+,\s*den\s+(\d{1,2}\.\s*[A-Za-zÄÖÜäöü]+\s*\d{4}),?\s*verwandelt sich der Biergarten am Chinesischen Turm\s*von\s*(\d{1,2})\s*(?:bis|–|-)\s*\d{1,2}\s*Uhr/i;

export async function run() {
  console.log('[kocherlball] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[kocherlball] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    console.log('[kocherlball] fetching', PAGE_URL);
    const res = await fetch(PAGE_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) { console.warn('[kocherlball] fetch failed', res.status); return; }
    const html = await res.text();
    const $ = cheerio.load(html);
    const bodyText = $('body').text().replace(/\s+/g, ' ');

    const match = bodyText.match(DATE_SENTENCE_PATTERN);
    if (!match) { console.log('[kocherlball] date sentence not found — Seite vermutlich umformuliert'); return; }

    const start_date = parseGermanDate(match[1]);
    const today = new Date().toISOString().slice(0, 10);
    if (!start_date || start_date < today) { console.log('[kocherlball] no upcoming date parsed'); return; }
    const start_time = `${match[2].padStart(2, '0')}:00`;

    const supabaseForCoords = supabase;
    const coords = await getCoordinates(supabaseForCoords, LOCATION, ADDRESS, 'München');

    const sourceId = buildStableSourceId('kocherlball', PAGE_URL, start_date);
    const row = {
      source_id: sourceId,
      title: 'Kocherlball',
      description: 'Traditionelles Frühschoppen-Tanzfest im Englischen Garten, Live-Blasmusik, Eintritt frei.',
      category: 'Feiern',
      subcategory: null,
      start_date,
      start_time,
      location_name: LOCATION,
      address: ADDRESS,
      city: 'München',
      organizer: 'Biergarten am Chinesischen Turm',
      source_url: PAGE_URL,
      image_url: null,
      price_info: 'Eintritt frei',
      latitude: coords?.latitude ?? null,
      longitude: coords?.longitude ?? null,
    };

    console.log('[kocherlball] upserting 1 event for', start_date);
    const { error } = await supabase.from('events').upsert([row], { onConflict: 'source_id' });
    if (error) console.error('[kocherlball] upsert error', error);
  } catch (err) {
    console.warn('[kocherlball] error', err);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

export default run;
