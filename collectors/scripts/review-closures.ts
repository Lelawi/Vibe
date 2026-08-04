import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Bewusst kein automatisierter Verifikations-Heuristik (z.B. "Website gibt
// 404" o.ä.) — dafür gibt es keine verlässliche freie Datenquelle, und ein
// falsch-positiv bestätigtes "existiert nicht mehr" würde einen echten
// Bar/Restaurant-Eintrag dauerhaft aus der App entfernen (siehe
// 0013_bar_closure_review.sql). Stattdessen: Meldungen auflisten, damit sie
// manuell (auf Zuruf an Claude, z.B. per Websuche/Website-Check) geprüft und
// dann per confirm/reject entschieden werden können. Deckt Bars UND
// Restaurants ab, seit venue_closure_reports beide über die generische
// venues-Tabelle abdeckt (0015_venues_generalize_for_restaurants.sql).
//
// Nutzung:
//   npm run review-closures                  -- listet offene ("pending") Meldungen
//   npm run review-closures -- confirm <id> [Notiz] -- Venue wird ausgeblendet
//   npm run review-closures -- reject <id> [Notiz]  -- Meldung wird verworfen

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../app/.env') });

export async function run() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[review-closures] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const [, , action, venueId, ...noteParts] = process.argv;

  if (action === 'confirm' || action === 'reject') {
    if (!venueId) { console.error(`[review-closures] usage: ${action} <venue_id>`); return; }
    const status = action === 'confirm' ? 'confirmed' : 'rejected';
    const reviewNote = noteParts.join(' ').trim() || null;
    const { error } = await supabase
      .from('venue_closure_reports')
      .update({ status, review_note: reviewNote })
      .eq('venue_id', venueId)
      .eq('status', 'pending');
    if (error) console.error('[review-closures] update failed', error);
    else console.log(`[review-closures] ${venueId} -> ${status}`);
    return;
  }

  const { data: reports, error } = await supabase
    .from('venue_closure_reports')
    .select('venue_id,reported_at,status')
    .eq('status', 'pending');
  if (error) { console.error('[review-closures] fetch failed', error); return; }
  if (!reports || reports.length === 0) { console.log('[review-closures] no pending reports'); return; }

  const { data: venues } = await supabase
    .from('venues')
    .select('id,name,name_override,type,address,website,opening_hours_raw,opening_hours_override,google_opening_hours')
    .in('id', reports.map((r) => r.venue_id));
  const venueById = new Map((venues ?? []).map((v) => [v.id, v]));

  console.log(`[review-closures] ${reports.length} pending report(s):\n`);
  for (const r of reports) {
    const venue = venueById.get(r.venue_id);
    console.log(`- [${venue?.type ?? '?'}] ${venue?.name_override ?? venue?.name ?? '(gelöscht?)'}  [${r.venue_id}]`);
    if (venue?.address) console.log(`  Adresse: ${venue.address}`);
    if (venue?.website) console.log(`  Website: ${venue.website}`);
    const effectiveHours = venue?.google_opening_hours ?? venue?.opening_hours_override ?? venue?.opening_hours_raw;
    if (effectiveHours) console.log(`  Öffnungszeiten: ${effectiveHours}`);
    console.log(`  gemeldet: ${r.reported_at}`);
    console.log('');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}

export default run;
