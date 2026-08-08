import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractBeerPriceFromKnownMenuUrl, extractBeerPrice, extractBeerPriceFromPdf } from '../core/venues';
import * as cheerio from 'cheerio';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });
if (!process.env.SUPABASE_URL) dotenv.config({ path: path.join(__dirname, '../../app/.env') });

// Einmaliger Nachtrag für bereits vorhandene Venues, ergänzend zum
// dauerhaften Fix in core/venues.ts (fetchWebsiteEnrichment prüft bekannte
// Kartenlinks jetzt bei jedem regulären wöchentlichen Lauf automatisch mit)
// — holt sofort nach, statt bis zum nächsten Montag zu warten (per
// Nutzer-Wunsch: "möglichst viele Bierpreise", "fange mit den Venues an,
// von denen du eh bereits eine Karte hinterlegt hast").
//
// Phase 1: Venues mit bekannter Mittags-/Abendkarte, aber noch ohne
// Bierpreis — direkt gegen die bekannte URL prüfen (zuverlässigste Quelle,
// bereits als echte Karte identifiziert statt nur erraten).
async function phase1(supabase: ReturnType<typeof createClient>) {
  const { data: venues, error } = await supabase
    .from('venues')
    .select('id,name,name_override,lunch_menu_url,dinner_menu_url')
    .is('beer_price_eur', null)
    .or('lunch_menu_url.not.is.null,dinner_menu_url.not.is.null');
  if (error) { console.error('[backfill-beer-prices] phase1 fetch failed', error); return; }
  console.log(`[backfill-beer-prices] phase1: ${venues?.length ?? 0} venues mit bekannter Karte, aber ohne Bierpreis`);

  let found = 0;
  for (const venue of venues ?? []) {
    const label = venue.name_override ?? venue.name;
    let price: number | null = null;
    for (const url of [venue.dinner_menu_url, venue.lunch_menu_url]) {
      if (!url) continue;
      price = await extractBeerPriceFromKnownMenuUrl(url);
      if (price !== null) break;
    }
    if (price !== null) {
      const { error: updateError } = await supabase
        .from('venues')
        .update({ beer_price_eur: price, updated_at: new Date().toISOString() })
        .eq('id', venue.id);
      if (updateError) console.error(`[backfill-beer-prices] update failed for ${label}`, updateError);
      else { found++; console.log(`[backfill-beer-prices] ✓ ${label}: ${price.toFixed(2)} €`); }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`[backfill-beer-prices] phase1 done: ${found}/${venues?.length ?? 0} neue Bierpreise`);
}

// Phase 2: Venues MIT Website, aber ohne bekannte Karte und ohne Bierpreis
// — Startseite + verlinkte PDFs nach Getränkekarten-typischen Begriffen
// durchsuchen (weiterer Fallback, deutlich niedrigere erwartete
// Trefferquote als Phase 1, da hier "geraten" statt eine bereits
// identifizierte Karte genutzt wird).
async function phase2(supabase: ReturnType<typeof createClient>) {
  const { data: venues, error } = await supabase
    .from('venues')
    .select('id,name,name_override,website')
    .is('beer_price_eur', null)
    .is('lunch_menu_url', null)
    .is('dinner_menu_url', null)
    .not('website', 'is', null);
  if (error) { console.error('[backfill-beer-prices] phase2 fetch failed', error); return; }
  console.log(`[backfill-beer-prices] phase2: ${venues?.length ?? 0} venues mit Website, aber ohne bekannte Karte und ohne Bierpreis`);

  let found = 0;
  let checked = 0;
  for (const venue of venues ?? []) {
    const label = venue.name_override ?? venue.name;
    checked++;
    try {
      const res = await fetch(venue.website!, {
        headers: { 'User-Agent': 'VibeApp-Collector/1.0 (nicht-kommerziell, github.com/Lelawi/Vibe)' },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const html = await res.text();
        const $ = cheerio.load(html);
        let price = extractBeerPrice($);
        if (price === null) {
          // Gleiche Getränkekarten-Schlagwortsuche wie findMenuPdfLinks in
          // core/venues.ts, hier bewusst dupliziert statt exportiert — nur
          // für diesen Backfill-Lauf gebraucht, kein Teil des regulären
          // Collector-Pfads.
          const pdfLinks: string[] = [];
          $('a[href]').each((_, el) => {
            const href = $(el).attr('href') ?? '';
            if (!/\.pdf(\?|$)/i.test(href)) return;
            if (!/karte|men[üu]|getr[äa]nk|getraenk|drinks|preis|bar/i.test(href) && !/karte|men[üu]|getr[äa]nk|getraenk|drinks|preis|bar/i.test($(el).text())) return;
            try { pdfLinks.push(new URL(href, venue.website!).toString()); } catch { /* ignore */ }
          });
          for (const pdfLink of pdfLinks.slice(0, 4)) {
            price = await extractBeerPriceFromPdf(pdfLink);
            if (price !== null) break;
          }
        }
        if (price !== null) {
          const { error: updateError } = await supabase
            .from('venues')
            .update({ beer_price_eur: price, updated_at: new Date().toISOString() })
            .eq('id', venue.id);
          if (updateError) console.error(`[backfill-beer-prices] update failed for ${label}`, updateError);
          else { found++; console.log(`[backfill-beer-prices] ✓ ${label}: ${price.toFixed(2)} €`); }
        }
      }
    } catch (err) {
      console.warn(`[backfill-beer-prices] error for ${label}`, err);
    }
    if (checked % 25 === 0) console.log(`[backfill-beer-prices] phase2 progress: ${checked}/${venues?.length ?? 0}, ${found} gefunden`);
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`[backfill-beer-prices] phase2 done: ${found}/${venues?.length ?? 0} neue Bierpreise`);
}

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[backfill-beer-prices] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  await phase1(supabase);
  const runPhase2 = process.argv.includes('--phase2');
  if (runPhase2) await phase2(supabase);
  else console.log('[backfill-beer-prices] phase2 übersprungen (--phase2 zum Ausführen anhängen)');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
