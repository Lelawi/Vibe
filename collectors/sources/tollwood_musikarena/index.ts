import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { getCoordinates } from '../../core/geocode';
import { buildStableSourceId, dedupeBySourceId } from '../../core/scrape';

// Tollwood Sommerfestival, Musik-Arena (Olympiapark Süd, jährlich Ende Juni
// bis Mitte Juli) — per Recherche entdeckt (2026-08-16, im Zuge der
// Bang-Bang!-Suche nach fehlenden Open-Airs): trotz ~30 kostenpflichtigen
// Konzerten/Jahr mit bekannten Namen (2026 u.a. Deep Purple, Sex Pistols,
// Sarah Connor) bislang nur vereinzelt über andere Quellen (meinestadt,
// muenchen-de) erfasst, keine 1:1-Abdeckung. Der Rest des Tollwood-Geländes
// (Markt der Ideen, Kulturprogramm — zu ~90% kostenlos) bleibt bewusst
// außen vor, dafür gibt es keine strukturierte Terminliste, nur die
// Musik-Arena hat eine eigene, sauber scrapbare Programmseite.
//
// tollwood.de/veranstaltungsort/musik-arena/ zeigt ganzjährig die bereits
// bestätigten Konzerte der NÄCHSTEN Ausgabe (per Direktabruf 2026-08
// verifiziert: 8 bestätigte 2027-Termine bereits online, obwohl das
// Sommerfestival 2026 da schon vorbei war) — kein Saison-Fenster-Problem,
// einfach ganzjährig laufen lassen wie jede andere Quelle.
const PROGRAM_URL = 'https://www.tollwood.de/veranstaltungsort/musik-arena/';
const LOCATION = 'Tollwood Musik-Arena';
const ADDRESS = 'Spiridon-Louis-Ring 100, 80809 München';

// "19.06.2027 | 19:00 Uhr | Musik-Arena" -> { date: '2027-06-19', time: '19:00' }.
// Termine ohne Datum ("Termin folgt" o.ä. bei noch nicht fixierten Acts)
// liefern hier bewusst null statt zu raten.
function parseSubline(text: string): { date: string | null; time: string | null } {
  const match = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\s*\|\s*(\d{1,2}):(\d{2})/);
  if (!match) return { date: null, time: null };
  const [, day, month, year, hour, minute] = match;
  const date = new Date(Date.UTC(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10)));
  if (isNaN(date.getTime())) return { date: null, time: null };
  return { date: date.toISOString().slice(0, 10), time: `${hour.padStart(2, '0')}:${minute}` };
}

export async function run() {
  console.log('[tollwood_musikarena] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[tollwood_musikarena] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const collected: any[] = [];
  const today = new Date().toISOString().slice(0, 10);

  try {
    console.log('[tollwood_musikarena] fetching', PROGRAM_URL);
    const res = await fetch(PROGRAM_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) { console.warn('[tollwood_musikarena] fetch failed', res.status); return; }
    const html = await res.text();
    const $ = cheerio.load(html);

    const coords = await getCoordinates(supabase, LOCATION, ADDRESS, 'München');

    $('.article-teaser .teaser').each((_, el) => {
      const teaser$ = $(el);
      const title = teaser$.find('.teaser-content .headline').first().text().replace(/\s+/g, ' ').trim();
      const subline = teaser$.find('.teaser-content .subline').first().text().replace(/\s+/g, ' ').trim();
      if (!title) return;

      const { date: start_date, time: start_time } = parseSubline(subline);
      if (!start_date || start_date < today) return;

      const detailUrl = teaser$.find('.teaser-image a').first().attr('href')
        ?? teaser$.find('.teaser-more a').first().attr('href')
        ?? PROGRAM_URL;

      // WordPress lazy-load: das echte Bild steckt in data-lazy-src, src
      // trägt bis zum ersten Scroll nur ein leeres Platzhalter-SVG als
      // data:-URI (siehe Direktabruf-Kommentar oben).
      const img$ = teaser$.find('.teaser-image img').first();
      const imageUrl = img$.attr('data-lazy-src') || (img$.attr('src')?.startsWith('data:') ? null : img$.attr('src')) || null;

      const sourceId = buildStableSourceId('tollwood-musikarena', detailUrl, start_date);
      collected.push({
        source_id: sourceId,
        title,
        description: null,
        category: 'Konzerte',
        subcategory: null,
        start_date,
        start_time,
        location_name: LOCATION,
        address: ADDRESS,
        city: 'München',
        organizer: 'Tollwood',
        source_url: detailUrl,
        image_url: imageUrl,
        price_info: null,
        latitude: coords?.latitude ?? null,
        longitude: coords?.longitude ?? null,
      });
    });
  } catch (err) {
    console.warn('[tollwood_musikarena] error', err);
  }

  if (collected.length === 0) { console.log('[tollwood_musikarena] no events parsed'); return; }
  console.log('[tollwood_musikarena] upserting', collected.length, 'events');
  const { error } = await supabase.from('events').upsert(dedupeBySourceId(collected), { onConflict: 'source_id' });
  if (error) console.error('[tollwood_musikarena] upsert error', error);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

export default run;
