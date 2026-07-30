import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Für den täglichen Cron-Check (siehe /loop-artige Erinnerung) statt einer
// echten Hintergrund-Automatisierung: fasst neue event_reports (Nutzer-
// Meldungen zu fehlerhaften Event-Daten, 0003_add_event_reports.sql) und
// offene venue_closure_reports (Bars & Restaurants, 0012/0013/0015) zusammen. Lädt dotenv selbst statt
// sich auf collect-all.ts's zentrales Laden zu verlassen, da dieses Skript
// eigenständig läuft.
//
// Nutzung: npx tsx collectors/scripts/check-feedback.ts [stundenFenster]
// stundenFenster (Default 26): wie weit event_reports zurückgeschaut wird,
// damit bei täglichem Lauf keine Lücke durch Timing-Drift entsteht.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../app/.env') });

async function run() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[check-feedback] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const hoursWindow = Number(process.argv[2] ?? 26);
  const since = new Date(Date.now() - hoursWindow * 3600_000).toISOString();

  const { data: reports, error: reportsError } = await supabase
    .from('event_reports')
    .select('id,event_id,reason,note,created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false });
  if (reportsError) console.error('[check-feedback] event_reports fetch failed', reportsError);

  const eventIds = [...new Set((reports ?? []).map((r) => r.event_id))];
  const { data: events } = eventIds.length
    ? await supabase.from('events').select('id,title,source_url').in('id', eventIds)
    : { data: [] as { id: string; title: string; source_url: string | null }[] };
  const eventById = new Map((events ?? []).map((e) => [e.id, e]));

  console.log(`[check-feedback] event_reports in last ${hoursWindow}h: ${reports?.length ?? 0}`);
  for (const r of reports ?? []) {
    const ev = eventById.get(r.event_id);
    console.log(`- "${ev?.title ?? r.event_id}" — ${r.reason ?? '(kein Grund)'} ${r.note ? `: ${r.note}` : ''} (${r.created_at})`);
    if (ev?.source_url) console.log(`  ${ev.source_url}`);
  }

  const { data: closures, error: closuresError } = await supabase
    .from('venue_closure_reports')
    .select('venue_id,reported_at,status')
    .eq('status', 'pending')
    .order('reported_at', { ascending: false });
  if (closuresError) console.error('[check-feedback] venue_closure_reports fetch failed', closuresError);

  const venueIds = (closures ?? []).map((c) => c.venue_id);
  const { data: venues } = venueIds.length
    ? await supabase.from('venues').select('id,name,type,address').in('id', venueIds)
    : { data: [] as { id: string; name: string; type: string; address: string | null }[] };
  const venueById = new Map((venues ?? []).map((v) => [v.id, v]));

  console.log(`\n[check-feedback] pending venue_closure_reports: ${closures?.length ?? 0}`);
  for (const c of closures ?? []) {
    const venue = venueById.get(c.venue_id);
    console.log(`- [${venue?.type ?? '?'}] ${venue?.name ?? c.venue_id} (${venue?.address ?? 'keine Adresse'}) — gemeldet ${c.reported_at}`);
  }
}

run();
