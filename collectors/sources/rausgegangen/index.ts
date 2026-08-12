import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { getCoordinates } from '../../core/geocode';
import { buildStableSourceId, dedupeBySourceId } from '../../core/scrape';

// Kostenlose Ergänzung zu Resident Advisor für die Münchner Clubszene. Die
// RA-Quelle nutzt mit schriftlicher Erlaubnis den internen GraphQL-Endpunkt;
// rausgegangen.de bleibt wegen teilweise anderer Events parallel aktiv und
// erlaubt Crawler explizit
// (robots.txt: "User-agent: *  Disallow:", ClaudeBot nur mit Crawl-Delay,
// nicht gesperrt). Die München-Techno-Tag-Seite liefert serverseitig
// gerenderte Event-Kacheln mit stabilen data-testid-Attributen (kein JSON-LD
// mit vollen Daten — das JSON-LD dort ist nur eine ItemList aus URLs), per
// Direktabruf verifiziert (2026-08): 27 Events auf der ersten (einzigen ohne
// Scroll/JS nachgeladenen) Seite.
const RAUSGEGANGEN_URL = 'https://rausgegangen.de/muenchen/tags/techno/';

const GERMAN_MONTH_ABBREV: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, mai: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, okt: 10, nov: 11, dez: 12,
};

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// "Morgen, 12. Aug" / "Fr, 21. Aug" / "Heute, ..." -> "2026-08-12". Anders
// als parseGermanDate in core/scrape.ts (numerisch oder voller Monatsname)
// braucht es hier deutsche Monats-KÜRZEL plus die beiden Relativ-Begriffe
// "Heute"/"Morgen", die rausgegangen.de statt eines Datums für die
// nächsten zwei Tage zeigt — deshalb ein eigener, kleiner Parser statt den
// gemeinsamen zu verbiegen.
function parseRausgegangenDate(text: string, reference = new Date()): string | null {
  const today = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate()));
  if (/^heute\b/i.test(text)) return isoDate(today);
  if (/^morgen\b/i.test(text)) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() + 1);
    return isoDate(d);
  }
  const match = text.match(/(\d{1,2})\.\s*([A-Za-zÄäÖöÜü]{3,4})/);
  if (!match) return null;
  const day = parseInt(match[1], 10);
  const monthKey = match[2]
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .slice(0, 3);
  const month = GERMAN_MONTH_ABBREV[monthKey];
  if (!month) return null;
  let year = reference.getUTCFullYear();
  let candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate < today) {
    year += 1;
    candidate = new Date(Date.UTC(year, month - 1, day));
  }
  return isNaN(candidate.getTime()) ? null : isoDate(candidate);
}

export async function run() {
  console.log('[rausgegangen] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[rausgegangen] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const collected: any[] = [];
  const today = new Date().toISOString().slice(0, 10);

  try {
    console.log('[rausgegangen] fetching', RAUSGEGANGEN_URL);
    const res = await fetch(RAUSGEGANGEN_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) { console.warn('[rausgegangen] fetch failed', res.status); return; }
    const html = await res.text();
    const $ = cheerio.load(html);

    $('[data-testid="event-tile"]').each((_, el) => {
      const tile = $(el);
      const href = tile.find('a[data-testid="event-tile-link"]').attr('href');
      const name = tile.find('[data-testid="event-tile-name"]').text().trim();
      if (!href || !name) return;

      // Erster <span> im datetime-Block ist das Datum (fett), zweiter die
      // Uhrzeit — per .text() zusammen abzufragen würde beides ohne
      // verlässliches Trennzeichen aneinanderkleben.
      const dtSpans = tile.find('[data-testid="event-tile-datetime"] span');
      const dateText = dtSpans.eq(0).text().trim();
      const timeText = dtSpans.eq(1).text().trim();
      const startDate = parseRausgegangenDate(dateText);
      if (!startDate || startDate < today) return;
      const startTime = /^\d{1,2}:\d{2}$/.test(timeText) ? timeText.padStart(5, '0') : null;

      const locationName = tile.find('[data-testid="event-tile-location"]').text().trim() || 'München';
      const priceText = tile.find('[data-testid="event-tile-price"]').text().trim() || null;
      const imageSrc = tile.find('[data-testid="event-tile-image"] img').attr('src') || null;

      let url: string;
      try { url = new URL(href, RAUSGEGANGEN_URL).toString(); } catch { return; }

      collected.push({
        source_id: buildStableSourceId('rausgegangen', url, startDate),
        title: name,
        category: 'Clubs',
        subcategory: 'Techno',
        start_date: startDate,
        start_time: startTime,
        location_name: locationName,
        city: 'München',
        source_url: url,
        image_url: imageSrc,
        price_info: priceText,
        // wird unten nachgereicht (async, daher nicht im Literal selbst)
      });
    });

    // Geocoding separat statt inline im .each() (synchron), da getCoordinates
    // async ist und cheerios .each() keine awaits im Callback erlaubt.
    for (const event of collected) {
      const coords = await getCoordinates(supabase, event.location_name, null, 'München');
      event.latitude = coords?.latitude ?? null;
      event.longitude = coords?.longitude ?? null;
    }
  } catch (err) {
    console.warn('[rausgegangen] error', err);
  }

  if (collected.length === 0) { console.log('[rausgegangen] no events parsed'); return; }
  console.log('[rausgegangen] upserting', collected.length, 'events');
  const { error } = await supabase.from('events').upsert(dedupeBySourceId(collected), { onConflict: 'source_id' });
  if (error) console.error('[rausgegangen] upsert error', error);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

export default run;
