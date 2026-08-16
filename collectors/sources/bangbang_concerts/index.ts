import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { getCoordinates } from '../../core/geocode';
import { buildStableSourceId, dedupeBySourceId, parseGermanDate } from '../../core/scrape';

// Bang Bang! Concerts, freier Münchner Konzertveranstalter (u.a. Bluesfest
// auf dem Rotkreuzplatz seit 1989) — per Nutzer-Hinweis entdeckt (2026-08-16:
// "heute Blues Fest auf dem Rotkreuzplatz"), war bislang durch keine Quelle
// abgedeckt. Eine einzige Übersichtsseite listet alle ~5 Termine/Jahr auf
// einmal (per Direktabruf verifiziert, 2026-08), keine Pagination nötig.
//
// Markup: #tab-timeline ul.timeline > li, je Termin ein Block aus
// .date h6.colr (Datum "DD. Monat YYYY"), .desc h5 a (Titel + Detail-Link),
// .thumb img (Bild), .txt p (Freitext-Beschreibung, manchmal mit
// "Adresse: Straße, PLZ München") und .gig-opts h6.time (Uhrzeit als
// "H:MMam/pm – H:MMpm" ODER "Den ganzen Tag") + a.location (uneinheitlich:
// mal echter Ortsname wie "Ampere"/"Rotkreuzplatz", mal nur der Termin-Titel
// wiederholt — kein JSON-LD vorhanden).
const OVERVIEW_URL = 'https://bangbangconcerts.de/veranstaltungen/';

// Nur für die Fälle, in denen a.location keinen brauchbaren Ortsnamen liefert
// (identisch mit dem Titel) UND der Freitext keine "Adresse:"-Angabe enthält
// — bewusst eine enge, von Hand kuratierte Liste statt eines generischen
// Fallbacks, analog zu core/venues.ts' EXCLUDED_VENUE_OSM_IDS-Prinzip.
const ADDRESS_BY_VENUE_NAME: Record<string, string> = {
  Muffatwerk: 'Zellstraße 4, 81667 München',
  Ampere: 'Zellstraße 4, 81667 München',
  Rotkreuzplatz: 'Rotkreuzplatz, 80634 München',
};

function textOf(el: cheerio.Cheerio<any>): string {
  return el.text().replace(/\s+/g, ' ').trim();
}

// "2:00pm – 10:00pm" / "7:30pm – 11:30pm" -> "14:00". "Den ganzen Tag" -> null.
function parseStartTime(raw: string): string | null {
  const match = raw.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!match) return null;
  let hour = parseInt(match[1], 10);
  const minute = match[2] ?? '00';
  const meridiem = match[3].toLowerCase();
  if (meridiem === 'pm' && hour !== 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${minute}`;
}

// "Adresse: Rotkreuzplatz, 80634 München Live on stage: ..." -> "Rotkreuzplatz, 80634 München".
// Nicht-gierig bis zur ersten PLZ+München-Kombination, damit nachfolgender
// Fließtext (Lineup etc.) nicht mit reingezogen wird.
function extractAddress(description: string): string | null {
  const match = description.match(/Adresse:\s*(.+?\d{5}\s*[A-ZÄÖÜ][a-zäöüß]+)/);
  return match ? match[1].trim() : null;
}

export async function run() {
  console.log('[bangbang_concerts] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[bangbang_concerts] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const collected: any[] = [];
  const today = new Date().toISOString().slice(0, 10);

  try {
    console.log('[bangbang_concerts] fetching', OVERVIEW_URL);
    const res = await fetch(OVERVIEW_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) { console.warn('[bangbang_concerts] fetch failed', res.status); return; }
    const html = await res.text();
    const $ = cheerio.load(html);

    for (const el of $('#tab-timeline ul.timeline > li').toArray()) {
      const li$ = $(el);

      const dateText = textOf(li$.find('.date h6').first());
      const start_date = parseGermanDate(dateText);
      if (!start_date || start_date < today) continue;

      const titleLink$ = li$.find('.desc h5 a').first();
      const title = textOf(titleLink$);
      const detailUrl = titleLink$.attr('href') || OVERVIEW_URL;
      if (!title) continue;

      const description = textOf(li$.find('.desc .txt p').first()) || null;
      const imageUrl = li$.find('.thumb img').first().attr('src') || null;

      const timeText = textOf(li$.find('.gig-opts h6.time').first());
      const start_time = parseStartTime(timeText);

      const rawLocation = textOf(li$.find('.gig-opts a.location').first());
      const locationIsJustTitle = !rawLocation || rawLocation.toLowerCase() === title.toLowerCase();
      const addressFromText = description ? extractAddress(description) : null;

      // Reihenfolge: 1) Adresse aus dem Freitext (am zuverlässigsten, enthält
      // meist schon den korrekten Ortsnamen als erstes Segment), 2) a.location,
      // wenn es einen echten Ort statt nur den wiederholten Titel nennt,
      // 3) kuratierte Adresse für bekannte Namen, 4) der Titel selbst als
      // letzter Ausweg (location_name ist NOT NULL) — Geocoding schlägt dann
      // einfach ergebnislos fehl, statt einen falschen Ort zu erfinden.
      const location_name = addressFromText
        ? addressFromText.split(',')[0].trim()
        : !locationIsJustTitle
          ? rawLocation
          : title;
      const address = addressFromText
        ?? (location_name in ADDRESS_BY_VENUE_NAME ? ADDRESS_BY_VENUE_NAME[location_name] : null);

      const price_info = description && /eintritt frei/i.test(description) ? 'Eintritt frei' : null;

      const sourceId = buildStableSourceId('bangbang-concerts', detailUrl, start_date);
      const coords = await getCoordinates(supabase, location_name, address, 'München');

      collected.push({
        source_id: sourceId,
        title,
        description,
        category: 'Konzerte',
        subcategory: null,
        start_date,
        start_time,
        location_name,
        address,
        city: 'München',
        organizer: 'Bang Bang! Concerts',
        source_url: detailUrl,
        image_url: imageUrl,
        price_info,
        latitude: coords?.latitude ?? null,
        longitude: coords?.longitude ?? null,
      });
    }
  } catch (err) {
    console.warn('[bangbang_concerts] error', err);
  }

  if (collected.length === 0) { console.log('[bangbang_concerts] no events parsed'); return; }
  console.log('[bangbang_concerts] upserting', collected.length, 'events');
  const { error } = await supabase.from('events').upsert(dedupeBySourceId(collected), { onConflict: 'source_id' });
  if (error) console.error('[bangbang_concerts] upsert error', error);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

export default run;
