import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { getCoordinates } from '../../core/geocode';

// Die offiziellen Oktoberfest-"Highlights" (Anstich, Trachten- und
// Schützenzug, Böllerschießen etc.) — nicht die Wiesn selbst (die ist kein
// einzelnes "Event" im Sinne der App), sondern die besonderen Programmpunkte
// während der Festzeit. Struktur per Direktabruf verifiziert (2026-07):
// <li class="m-teaser-list__list-item"> mit <h3 class="m-teaser-vertical__headline">
// <a href>Titel (M/D)</a></h3> — das Datum steht als "(Monat/Tag)" direkt im
// Linktext, nicht als eigenes strukturiertes Feld. Nur die englische Version
// der Seite ist unter dieser URL erreichbar (die deutschen Pfad-Varianten
// führten trotz sichtbarem "Termine"-Menüpunkt zu 404) — Titel/Untertitel
// bleiben deshalb auf Englisch, bis eine funktionierende DE-URL gefunden ist.
const OKTOBERFEST_URL = 'https://www.oktoberfest.de/en/information/events';
const OKTOBERFEST_ADDRESS = 'Theresienwiese, 80336 München';
const BASE_URL = 'https://www.oktoberfest.de';

export async function run() {
  console.log('[oktoberfest_events] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[oktoberfest_events] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const collected: any[] = [];
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  try {
    console.log('[oktoberfest_events] fetching', OKTOBERFEST_URL);
    const res = await fetch(OKTOBERFEST_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) { console.warn('[oktoberfest_events] fetch failed', res.status); return; }
    const html = await res.text();
    const $ = cheerio.load(html);

    const coords = await getCoordinates(supabase, 'Theresienwiese', OKTOBERFEST_ADDRESS, 'München');

    $('.m-teaser-list__list-item').each((_, el) => {
      const el$ = $(el);
      const link = el$.find('h3.m-teaser-vertical__headline a').first();
      const rawTitle = link.text().replace(/\s+/g, ' ').trim();
      const href = link.attr('href');
      const tagline = el$.find('.m-teaser-vertical__tagline').first().text().trim() || null;
      if (!rawTitle || !href) return;

      // Datum steckt als "(M/D)" am Ende des Titeltexts, z.B. "... (9/19)".
      const dateMatch = rawTitle.match(/\((\d{1,2})\/(\d{1,2})\)\s*$/);
      if (!dateMatch) return; // kein erkennbares Datum — ohne Rätselraten überspringen

      const month = parseInt(dateMatch[1], 10);
      const day = parseInt(dateMatch[2], 10);
      let year = today.getFullYear();
      let candidate = new Date(Date.UTC(year, month - 1, day));
      if (candidate.toISOString().slice(0, 10) < todayStr) {
        year += 1;
        candidate = new Date(Date.UTC(year, month - 1, day));
      }
      const start_date = candidate.toISOString().slice(0, 10);

      const title = rawTitle.replace(/\s*\(\d{1,2}\/\d{1,2}\)\s*$/, '').trim();
      let sourceUrl: string;
      try {
        sourceUrl = new URL(href, BASE_URL).toString();
      } catch {
        return;
      }

      const imgSrc = el$.find('img').first().attr('src') || el$.find('img').first().attr('data-src');
      let imageUrl: string | null = null;
      if (imgSrc) {
        try {
          imageUrl = new URL(imgSrc, BASE_URL).toString();
        } catch {
          imageUrl = null;
        }
      }

      collected.push({
        source_id: `oktoberfest-events-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${year}`,
        title,
        description: tagline,
        category: 'Feiern',
        subcategory: 'Oktoberfest',
        start_date,
        start_time: null,
        location_name: 'Theresienwiese',
        address: OKTOBERFEST_ADDRESS,
        city: 'München',
        organizer: 'Landeshauptstadt München',
        source_url: sourceUrl,
        image_url: imageUrl,
        price_info: null,
        latitude: coords?.latitude ?? null,
        longitude: coords?.longitude ?? null,
      });
    });
  } catch (err) {
    console.warn('[oktoberfest_events] error', err);
  }

  if (collected.length === 0) { console.log('[oktoberfest_events] no events parsed'); return; }
  console.log('[oktoberfest_events] upserting', collected.length, 'events');
  const { error } = await supabase.from('events').upsert(collected, { onConflict: 'source_id' });
  if (error) console.error('[oktoberfest_events] upsert error', error);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

export default run;
