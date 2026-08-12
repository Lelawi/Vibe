import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../app/.env') });

// Kostenlose Bild-Ergaenzung fuer Venues (Spaetis/Bars/Restaurants), die
// bereits eine eigene Website hinterlegt haben, aber noch kein image_url --
// dieselbe og:image-Technik wie beim muenchen-stadtportal-Ticket-Link-Trick
// (siehe sources/muenchen_stadtportal/index.ts), nur fuer Venue-Websites
// statt Event-Ticket-Links. Bewusst KEINE Google-Places-Photos-API (neuer,
// bisher nicht autorisierter Kostenpunkt jenseits der bestehenden
// Google-Ratings-Ausnahme, siehe CLAUDE.md "Google ratings") -- reines
// HTTP-og:image-Scraping ist kostenlos.
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
};
const REQUEST_TIMEOUT_MS = 8_000;
const BATCH_SIZE = Number(process.env.VENUE_IMAGE_BATCH ?? 600);

async function fetchOgImage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) return null;
    const html = await res.text();
    const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
    if (og?.[1]) return new URL(og[1], url).toString();
    // Facebook-Seiten liefern og:image selten im initialen HTML (JS-Rendering)
    // -- kein Fallback dafuer, bewusst uebersprungen statt teure Heuristiken.
    return null;
  } catch {
    return null;
  }
}

export async function run() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[backfill-venue-images] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const { data: venues, error } = await supabase
    .from('venues')
    .select('id, name, name_override, website')
    .is('closed_at', null)
    .in('type', ['spaeti', 'bar', 'restaurant'])
    .is('image_url', null)
    .not('website', 'is', null)
    .limit(BATCH_SIZE);
  if (error) { console.error('[backfill-venue-images] fetch error', error); return; }
  if (!venues?.length) { console.log('[backfill-venue-images] nothing to do'); return; }

  let found = 0, notFound = 0;
  for (const v of venues) {
    const label = v.name_override || v.name;
    try {
      const image = await fetchOgImage(v.website as string);
      if (image) {
        await supabase.from('venues').update({ image_url: image }).eq('id', v.id);
        found++;
        console.log(`[backfill-venue-images] ${label} -> found`);
      } else {
        notFound++;
      }
    } catch (err) {
      notFound++;
      console.warn(`[backfill-venue-images] error for "${label}"`, err);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`[backfill-venue-images] done — ${found} found, ${notFound} not found (of ${venues.length})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}

export default run;
