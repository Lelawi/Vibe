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

  const { data: venues, error } = await supabase
    .from('venues')
    .select('id,name,name_override,website,lunch_menu_url,dinner_menu_url')
    .is('beer_price_eur', null)
    .not('website', 'is', null);
  if (error) { console.error('[backfill-beer-prices] fetch failed', error); return; }
  console.log(`[backfill-beer-prices] ${venues?.length ?? 0} venues mit Website, aber ohne Bierpreis`);

  let found = 0;
  let checked = 0;
  for (const venue of venues ?? []) {
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
    if (checked % 50 === 0) console.log(`[backfill-beer-prices] progress: ${checked}/${venues?.length ?? 0}, ${found} gefunden`);
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log(`[backfill-beer-prices] done: ${found}/${venues?.length ?? 0} neue Bierpreise`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
