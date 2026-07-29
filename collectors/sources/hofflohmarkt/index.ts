import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { getCoordinates } from '../../core/geocode';

// Hofflohmärkte München: an wechselnden Terminen öffnen alle Höfe eines
// Stadtviertels gleichzeitig für einen Flohmarkt. Die Seite ist mittlerweile
// (Stand 2026-07, war vorher reiner Fließtext) ein Shopify-Produkt zur
// Hof-Anmeldung — die Termine selbst stecken strukturiert als JSON in einem
// <script type="application/json">-Tag (Produktvarianten), z.B.
// {"title":"Dachau Udldinger Weiher · So. 14.06.26 · 11 - 16 Uhr", ...}.
// Das ist robuster als der alte Fließtext-Regex und bleibt der öffentlich
// relevante Termin, auch wenn die Seite sich an Standbetreiber statt Besucher
// richtet.
const HOFFLOHMARKT_URL = 'https://www.hofflohmaerkte.de/pages/hofflohmarkte-munchen';

// Die Seite zeigt für die nächsten Termine eine "Tourplan hier"-Kachelreihe
// (.multicolumn-card) mit echtem Viertel-Foto — deckt aber nur eine Handvoll
// der kommenden Termine ab, nicht alle. Für Termine ohne eigenes Foto auf ein
// generisches, unspezifisches Atmosphäre-Foto derselben Seite zurückfallen
// (kein Logo, echtes Marktfoto — per Direktabruf verifiziert, 2026-07),
// statt image_url leer zu lassen: bessere Kartenoptik und qualifiziert die
// Events für die "Empfohlen für dich"-Karussell-Zeile in der App, die Events
// ohne Bild kategorisch ausschließt.
const GENERIC_FALLBACK_IMAGE = 'https://www.hofflohmaerkte.de/cdn/shop/files/hofflohmaerkte-2026-01.jpg?width=1200';

function normalizeDistrictKey(s: string): string {
  return s.toLowerCase().replace(/[^a-zäöüß0-9]+/g, '');
}

function extractDistrictImages($: cheerio.CheerioAPI, baseUrl: string): Map<string, string> {
  const map = new Map<string, string>();
  $('.multicolumn-card').each((_, el) => {
    const card = $(el);
    const heading = card.find('h3, .multicolumn-card__heading, [class*=heading]').first().text().trim();
    const src = card.find('img').first().attr('src');
    if (!heading || !src) return;
    try {
      map.set(normalizeDistrictKey(heading), new URL(src, baseUrl).toString());
    } catch {
      // ignore malformed src
    }
  });
  return map;
}

// Matched z.B. "Dachau Udldinger Weiher · So. 14.06.26 · 11 - 16 Uhr" oder
// "Kleinhadern & Blumenau · Sa. 23.05.2026 · 10 - 16 Uhr" (Titel eines
// Shopify-Produktvarianten-Eintrags, Jahr auf der Seite uneinheitlich 2- oder
// 4-stellig) — Viertel, Datum, Startzeit.
const TITLE_PATTERN =
  /^(.+?)\s*·\s*[A-Za-zÄÖÜäöü]{2}\.\s*(\d{2})\.(\d{2})\.(\d{2}|\d{4})\s*·\s*(\d{1,2})(?::(\d{2}))?\s*-\s*\d{1,2}(?::\d{2})?\s*Uhr/;

export async function run() {
  console.log('[hofflohmarkt] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[hofflohmarkt] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const collected: any[] = [];
  const today = new Date().toISOString().slice(0, 10);

  try {
    console.log('[hofflohmarkt] fetching', HOFFLOHMARKT_URL);
    const res = await fetch(HOFFLOHMARKT_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) { console.warn('[hofflohmarkt] fetch failed', res.status); return; }
    const html = await res.text();
    const $ = cheerio.load(html);
    const districtImages = extractDistrictImages($, HOFFLOHMARKT_URL);

    const seen = new Set<string>();

    const scripts = $('script[type="application/json"]')
      .toArray()
      .map((el) => $(el).html())
      .filter(Boolean) as string[];

    for (const raw of scripts) {
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        continue; // andere application/json-Blöcke auf der Seite ignorieren
      }
      if (!Array.isArray(data)) continue;

      for (const entry of data) {
        const title = (entry as { title?: unknown })?.title;
        if (typeof title !== 'string') continue;

        const m = title.match(TITLE_PATTERN);
        if (!m) continue;
        const [, districtRaw, dayStr, monthStr, yearStr, hourStr, minStr] = m;
        const district = districtRaw.trim();
        if (!district) continue;

        const day = parseInt(dayStr, 10);
        const month = parseInt(monthStr, 10);
        const year = yearStr.length === 2 ? 2000 + parseInt(yearStr, 10) : parseInt(yearStr, 10);
        const candidate = new Date(year, month - 1, day);
        if (isNaN(candidate.getTime())) continue;
        const start_date = candidate.toISOString().slice(0, 10);
        if (start_date < today) continue;

        const dedupeKey = `${district}-${start_date}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        const start_time = `${hourStr.padStart(2, '0')}:${minStr ?? '00'}`;
        const locationName = `Hofflohmarkt ${district}`;
        const coords = await getCoordinates(supabase, `${district}, München`, null, 'München');

        collected.push({
          source_id: `hofflohmarkt-${district.toLowerCase().replace(/[^a-zäöüß0-9]+/g, '-')}-${start_date}`,
          title: locationName,
          description: `Nachbarschafts-Flohmarkt im Viertel ${district} — Details/Tourplan auf ${HOFFLOHMARKT_URL}`,
          category: 'Märkte',
          subcategory: 'Hofflohmarkt',
          start_date,
          start_time,
          location_name: locationName,
          address: null,
          city: 'München',
          organizer: 'hofflohmaerkte.de',
          source_url: HOFFLOHMARKT_URL,
          image_url: districtImages.get(normalizeDistrictKey(district)) ?? GENERIC_FALLBACK_IMAGE,
          // Wie bei Flohmärkten üblich zahlen nur die Höfe/Standbetreibenden
          // eine Teilnahmegebühr, der Eintritt für Besuchende ist frei.
          price_info: 'Kostenlos',
          latitude: coords?.latitude ?? null,
          longitude: coords?.longitude ?? null,
        });
      }
    }
  } catch (err) {
    console.warn('[hofflohmarkt] error', err);
  }

  if (collected.length === 0) { console.log('[hofflohmarkt] no events parsed'); return; }
  console.log('[hofflohmarkt] upserting', collected.length, 'events');
  const { error } = await supabase.from('events').upsert(collected, { onConflict: 'source_id' });
  if (error) console.error('[hofflohmarkt] upsert error', error);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

export default run;
