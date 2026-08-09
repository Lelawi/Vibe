import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchWebsiteEnrichment } from '../core/venues';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });
if (!process.env.SUPABASE_URL) dotenv.config({ path: path.join(__dirname, '../../app/.env') });

// Einmaliger Nachtrag für bereits vorhandene Venues, ergänzend zum
// dauerhaften Fix in core/venues.ts (fetchWebsiteEnrichment prüft jetzt bei
// jedem regulären wöchentlichen Lauf automatisch eine eigens gesuchte
// Getränkekarte sowie bekannte Speise-/Abendkartenlinks) — holt sofort
// nach, statt bis zum nächsten Montag zu warten (per Nutzer-Wunsch:
// "möglichst viele Bierpreise").
//
// Ruft dieselbe fetchWebsiteEnrichment()-Funktion wie der reguläre
// Collector-Lauf auf (keine eigene Logik mehr, siehe Git-Historie für die
// vorherige, separate Phase-1/Phase-2-Version) — damit profitiert dieser
// Nachtrag automatisch von jeder künftigen Verbesserung der Extraktion,
// ohne zwei Stellen synchron halten zu müssen.
async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[backfill-beer-prices] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  // Supabase deckelt jede Abfrage hart bei 1000 Zeilen, unabhängig vom
  // angeforderten .limit() (gleiche Falle wie app/lib/fetchAllVenues.ts) —
  // eine einfache .select() hätte bei ~2200 Treffern über die Hälfte
  // stillschweigend verschluckt (per Live-Lauf beobachtet: 1000 statt der
  // tatsächlich erwarteten ~2200 Venues). Erst zählen, dann seitenweise mit
  // .range() holen, id als Tiebreaker für eine deterministische Reihenfolge.
  const PAGE_SIZE = 1000;
  const { count, error: countError } = await supabase
    .from('venues')
    .select('id', { count: 'exact', head: true })
    .is('beer_price_eur', null)
    .not('website', 'is', null);
  if (countError) { console.error('[backfill-beer-prices] count failed', countError); return; }
  const pageCount = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));
  const pages = await Promise.all(
    Array.from({ length: pageCount }, (_, i) =>
      supabase
        .from('venues')
        .select('id,name,name_override,website,lunch_menu_url,dinner_menu_url')
        .is('beer_price_eur', null)
        .not('website', 'is', null)
        .order('id', { ascending: true })
        .range(i * PAGE_SIZE, i * PAGE_SIZE + PAGE_SIZE - 1)
    )
  );
  for (const p of pages) {
    if (p.error) console.error('[backfill-beer-prices] page fetch failed', p.error);
  }
  const venues = pages.flatMap((p) => p.data ?? []);
  console.log(`[backfill-beer-prices] ${venues.length} venues mit Website, aber ohne Bierpreis (${count} laut Zählung)`);

  let found = 0;
  let checked = 0;
  for (const venue of venues) {
    const label = venue.name_override ?? venue.name;
    checked++;
    try {
      const enrichment = await fetchWebsiteEnrichment(venue.website!, {
        lunch: venue.lunch_menu_url,
        dinner: venue.dinner_menu_url,
      });
      if (enrichment.beerPriceEur !== null) {
        const { error: updateError } = await supabase
          .from('venues')
          .update({
            beer_price_eur: enrichment.beerPriceEur,
            // Gleich mitnehmen, falls neu gefunden — kostet nichts extra,
            // derselbe Abruf hat sie bereits ermittelt.
            dinner_menu_url: enrichment.dinnerMenuUrl ?? venue.dinner_menu_url,
            lunch_menu_url: enrichment.lunchMenuUrl ?? venue.lunch_menu_url,
            updated_at: new Date().toISOString(),
          })
          .eq('id', venue.id);
        if (updateError) console.error(`[backfill-beer-prices] update failed for ${label}`, updateError);
        else { found++; console.log(`[backfill-beer-prices] ✓ ${label}: ${enrichment.beerPriceEur.toFixed(2)} €`); }
      }
    } catch (err) {
      console.warn(`[backfill-beer-prices] error for ${label}`, err);
    }
    if (checked % 50 === 0) console.log(`[backfill-beer-prices] progress: ${checked}/${venues.length}, ${found} gefunden`);
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log(`[backfill-beer-prices] done: ${found}/${venues.length} neue Bierpreise`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
