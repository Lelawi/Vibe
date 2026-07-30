import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';

// Bewusst kein automatisierter Verifikations-Heuristik (z.B. "Website gibt
// 404" o.ä.) — dafür gibt es keine verlässliche freie Datenquelle, und ein
// falsch-positiv bestätigtes "existiert nicht mehr" würde eine echte Bar
// dauerhaft aus der App entfernen (siehe 0013_bar_closure_review.sql).
// Stattdessen: Meldungen auflisten, damit sie manuell (auf Zuruf an Claude,
// z.B. per Websuche/Website-Check) geprüft und dann per confirm/reject
// entschieden werden können.
//
// Nutzung:
//   npm run review-bar-closures                  -- listet offene ("pending") Meldungen
//   npm run review-bar-closures -- confirm <id>   -- Bar wird in der App ausgeblendet
//   npm run review-bar-closures -- reject <id>    -- Meldung verworfen, Bar bleibt normal sichtbar

export async function run() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[review-closures] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const [, , action, barId] = process.argv;

  if (action === 'confirm' || action === 'reject') {
    if (!barId) { console.error(`[review-closures] usage: ${action} <bar_id>`); return; }
    const status = action === 'confirm' ? 'confirmed' : 'rejected';
    const { error } = await supabase.from('bar_closure_reports').update({ status }).eq('bar_id', barId);
    if (error) console.error('[review-closures] update failed', error);
    else console.log(`[review-closures] ${barId} -> ${status}`);
    return;
  }

  const { data: reports, error } = await supabase
    .from('bar_closure_reports')
    .select('bar_id,reported_at,status')
    .eq('status', 'pending');
  if (error) { console.error('[review-closures] fetch failed', error); return; }
  if (!reports || reports.length === 0) { console.log('[review-closures] no pending reports'); return; }

  const { data: bars } = await supabase
    .from('bars')
    .select('id,name,address,website,opening_hours_raw')
    .in('id', reports.map((r) => r.bar_id));
  const barById = new Map((bars ?? []).map((b) => [b.id, b]));

  console.log(`[review-closures] ${reports.length} pending report(s):\n`);
  for (const r of reports) {
    const bar = barById.get(r.bar_id);
    console.log(`- ${bar?.name ?? '(gelöscht?)'}  [${r.bar_id}]`);
    if (bar?.address) console.log(`  Adresse: ${bar.address}`);
    if (bar?.website) console.log(`  Website: ${bar.website}`);
    if (bar?.opening_hours_raw) console.log(`  OSM-Öffnungszeiten: ${bar.opening_hours_raw}`);
    console.log(`  gemeldet: ${r.reported_at}`);
    console.log('');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}

export default run;
