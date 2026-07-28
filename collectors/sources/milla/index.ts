import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { getCoordinates } from '../../core/geocode';

// milla-club.de rendert die Kategorie-Archivseite ungewöhnlich (ein voller
// Blogpost pro "Seite", Datum als Freitext irgendwo im Artikeltext, z.B.
// "~~~~~ 12.11.2026 Einlass 19:00 ~~~~~") — der RSS-Feed liefert dieselben
// Posts sauber strukturiert (Titel, Link, Volltext), das echte Konzertdatum
// muss trotzdem aus dem Volltext geregext werden, da RSS `pubDate` nur das
// Veröffentlichungsdatum des Blogposts ist, nicht der Konzerttermin.
const MILLA_FEED_URL = 'https://milla-club.de/category/event/feed/';
const MILLA_ADDRESS = 'Holzstraße 28, 80469 München';
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
};

export async function run() {
  console.log('[milla] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[milla] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const collected: any[] = [];
  const today = new Date().toISOString().slice(0, 10);

  try {
    console.log('[milla] fetching', MILLA_FEED_URL);
    const res = await fetch(MILLA_FEED_URL, { headers: BROWSER_HEADERS });
    if (!res.ok) { console.warn('[milla] fetch failed', res.status); return; }
    const xml = await res.text();
    const $ = cheerio.load(xml, { xmlMode: true });

    const coords = await getCoordinates(supabase, 'Milla Club', MILLA_ADDRESS, 'München');

    $('item').each((_, el) => {
      const item$ = $(el);
      const title = item$.find('title').first().text().trim();
      const link = item$.find('link').first().text().trim();
      const content = item$.find('content\\:encoded').first().text() || item$.find('description').first().text();
      if (!title || !link || !content) return;

      const dateMatch = content.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
      if (!dateMatch) return; // Post ohne erkennbares Konzertdatum im Text — ignorieren

      const [, day, month, year] = dateMatch;
      const start_date = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
      if (start_date < today) return;

      const timeMatch = content.match(/Beginn\s*(\d{1,2})[:.](\d{2})/i) ?? content.match(/Einlass\s*(\d{1,2})[:.](\d{2})/i);
      const start_time = timeMatch ? `${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}` : null;

      // Preisangaben stehen als Freitext wie "VVK 20 € zzgl. Gebühren // AK 25 €"
      // im Post, meist mit HTML-Tags durchsetzt (<strong>, <br> etc.).
      const plainText = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      const priceMatch = plainText.match(/(VVK|AK|Eintritt)[^~]{0,80}/i);
      const price_info = priceMatch ? priceMatch[0].trim() : null;

      collected.push({
        source_id: `milla-${Buffer.from(link).toString('base64').slice(0, 20)}`,
        title,
        description: null,
        category: 'Clubs',
        subcategory: null,
        start_date,
        start_time,
        location_name: 'Milla Club',
        address: MILLA_ADDRESS,
        city: 'München',
        organizer: 'Milla Club',
        source_url: link,
        image_url: null,
        price_info,
        sold_out: null,
        latitude: coords?.latitude ?? null,
        longitude: coords?.longitude ?? null,
      });
    });
  } catch (err) {
    console.warn('[milla] error', err);
  }

  if (collected.length === 0) { console.log('[milla] no events parsed'); return; }
  console.log('[milla] upserting', collected.length, 'events');
  const { error } = await supabase.from('events').upsert(collected, { onConflict: 'source_id' });
  if (error) console.error('[milla] upsert error', error);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

export default run;
