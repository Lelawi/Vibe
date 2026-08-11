import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../app/.env'), quiet: true });

// Anders als weekly-review.ts (nur offene, noch unentschiedene Faelle) zeigt
// dieses Skript die VOLLSTAENDIGE Historie aller Nutzerhinweise -- auch
// bereits automatisiert oder manuell entschiedene -- als nachtraeglich
// pruefbares Prokoll: wann kam der Hinweis, wann/wie hat die automatische
// Vorpruefung entschieden, wann/wie die manuelle Entscheidung (falls
// noetig). Bewusst kein Live-Dashboard, sondern ein einmalig erzeugter
// Bericht -- bei Bedarf einfach erneut ausfuehren.
//
// Nutzung:
//   npm run feedback-history                 -- alle Kategorien, chronologisch
//   npm run feedback-history -- --since 2026-08-01 -- nur ab diesem Datum eingegangene

const line = (value: unknown) => value == null || value === '' ? '—' : String(value);
const date = (value: string | null) => value ? new Date(value).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' }) : '—';

function parseSince(): string | null {
  const idx = process.argv.indexOf('--since');
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  return value ? new Date(value).toISOString() : null;
}

// Fasst die Entscheidungsstufen eines Eintrags in eine kompakte Zeitleiste:
// Eingang -> automatische Vorpruefung -> manuelle Entscheidung (falls schon
// erfolgt). Alle drei Zeitstempel koennen unabhaengig voneinander fehlen
// (z.B. noch kein automatischer Check gelaufen, oder automatisch abschliessend
// entschieden ohne manuellen Schritt).
function timeline(row: {
  created_at: string;
  analysis_status: string | null;
  analysis_summary: string | null;
  analysis_confidence: number | null;
  analysis_category?: string | null;
  analyzed_at: string | null;
  status: string;
  review_note: string | null;
  reviewed_at: string | null;
}): string[] {
  const lines: string[] = [];
  lines.push(`- **Eingegangen:** ${date(row.created_at)}`);
  if (row.analyzed_at) {
    const cat = row.analysis_category ? ` [${row.analysis_category}]` : '';
    lines.push(`- **Automatisch geprueft** (${date(row.analyzed_at)})${cat}: ${line(row.analysis_summary)} — Status \`${row.analysis_status}\`, Konfidenz ${line(row.analysis_confidence)}`);
  } else {
    lines.push(`- **Automatisch geprueft:** noch nicht (Status \`${row.analysis_status}\`)`);
  }
  if (row.reviewed_at) {
    lines.push(`- **Manuelle Entscheidung** (${date(row.reviewed_at)}): \`${row.status}\`${row.review_note ? ` — ${row.review_note}` : ''}`);
  } else {
    lines.push(`- **Manuelle Entscheidung:** noch offen (aktueller Status \`${row.status}\`)`);
  }
  return lines;
}

export async function run(write: (value: string) => void = console.log): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { write('[feedback-history] Supabase-Umgebung fehlt'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);
  const since = parseSince();

  let closuresQuery = supabase.from('venue_closure_reports')
    .select('venue_id,reported_at,status,review_note,reviewed_at,analysis_status,analysis_category,analysis_summary,analysis_confidence,analyzed_at')
    .order('reported_at');
  let venueReportsQuery = supabase.from('venue_reports')
    .select('id,venue_id,reason,note,created_at,status,review_note,reviewed_at,analysis_status,analysis_category,analysis_summary,analysis_confidence,analyzed_at')
    .order('created_at');
  let eventReportsQuery = supabase.from('event_reports')
    .select('id,event_id,reason,note,created_at,status,review_note,reviewed_at,analysis_status,analysis_category,analysis_summary,analysis_confidence,analyzed_at')
    .order('created_at');
  let appFeedbackQuery = supabase.from('app_feedback')
    .select('id,message,screenshot_path,page_context,created_at,status,review_note,reviewed_at,analysis_status,analysis_category,analysis_summary,analysis_confidence,analyzed_at')
    .order('created_at');
  let missingQuery = supabase.from('missing_items')
    .select('id,kind,name,event_date,location,source_url,note,page_context,created_at,status,review_note,reviewed_at,analysis_status,analysis_category,analysis_summary,analysis_confidence,analyzed_at')
    .order('created_at');

  if (since) {
    closuresQuery = closuresQuery.gte('reported_at', since);
    venueReportsQuery = venueReportsQuery.gte('created_at', since);
    eventReportsQuery = eventReportsQuery.gte('created_at', since);
    appFeedbackQuery = appFeedbackQuery.gte('created_at', since);
    missingQuery = missingQuery.gte('created_at', since);
  }

  const [closuresResult, venueReportsResult, eventReportsResult, appFeedbackResult, missingResult] = await Promise.all([
    closuresQuery, venueReportsQuery, eventReportsQuery, appFeedbackQuery, missingQuery,
  ]);
  for (const result of [closuresResult, venueReportsResult, eventReportsResult, appFeedbackResult, missingResult]) {
    if (result.error) throw result.error;
  }

  const closures = closuresResult.data ?? [];
  const venueReports = venueReportsResult.data ?? [];
  const eventReports = eventReportsResult.data ?? [];
  const appFeedback = appFeedbackResult.data ?? [];
  const missing = missingResult.data ?? [];

  const venueIds = [...new Set([...closures.map((r) => r.venue_id), ...venueReports.map((r) => r.venue_id)])];
  const eventIds = [...new Set(eventReports.map((r) => r.event_id))];
  const { data: venues, error: venuesError } = venueIds.length
    ? await supabase.from('venues').select('id,name,name_override,type,address').in('id', venueIds)
    : { data: [], error: null };
  const { data: events, error: eventsError } = eventIds.length
    ? await supabase.from('events').select('id,title,start_date,start_time,location_name').in('id', eventIds)
    : { data: [], error: null };
  if (venuesError) throw venuesError;
  if (eventsError) throw eventsError;
  const venueById = new Map((venues ?? []).map((v) => [v.id, v]));
  const eventById = new Map((events ?? []).map((e) => [e.id, e]));

  const total = closures.length + venueReports.length + eventReports.length + appFeedback.length + missing.length;
  write(`# Vibe-Feedback-Historie\n`);
  write(`${total} Hinweis(e) insgesamt${since ? ` seit ${date(since)}` : ''} · erzeugt ${date(new Date().toISOString())}\n`);

  write(`## 1. Als geschlossen gemeldete Locations (${closures.length})\n`);
  for (const r of closures) {
    const venue = venueById.get(r.venue_id);
    write(`### closure:${r.venue_id} — ${venue?.name_override ?? venue?.name ?? r.venue_id}`);
    write(`Typ/Adresse: ${line(venue?.type)} · ${line(venue?.address)}`);
    for (const l of timeline({ ...r, created_at: r.reported_at })) write(l);
    write('');
  }

  write(`## 2. Bierpreise und andere Venue-Daten (${venueReports.length})\n`);
  for (const r of venueReports) {
    const venue = venueById.get(r.venue_id);
    write(`### venue:${r.id} — ${venue?.name_override ?? venue?.name ?? r.venue_id}`);
    write(`Meldung: ${line(r.reason)} · ${line(r.note)}`);
    for (const l of timeline(r)) write(l);
    write('');
  }

  write(`## 3. Fehlerhafte Eventdaten (${eventReports.length})\n`);
  for (const r of eventReports) {
    const event = eventById.get(r.event_id);
    write(`### event:${r.id} — ${event?.title ?? r.event_id}`);
    write(`Meldung: ${line(r.reason)} · ${line(r.note)}`);
    write(`Event: ${line(event?.start_date)} ${line(event?.start_time)} · ${line(event?.location_name)}`);
    for (const l of timeline(r)) write(l);
    write('');
  }

  write(`## 4. Fehlende Events oder Locations (${missing.length})\n`);
  for (const r of missing) {
    write(`### missing:${r.id} — [${r.kind}] ${r.name}`);
    write(`Datum/Ort: ${line(r.event_date)} · ${line(r.location)}`);
    write(`Quelle/Notiz: ${line(r.source_url)} · ${line(r.note)}`);
    for (const l of timeline(r)) write(l);
    write('');
  }

  write(`## 5. Sonstiges App-Feedback (${appFeedback.length})\n`);
  for (const r of appFeedback) {
    let screenshot = '—';
    if (r.screenshot_path) {
      const { data: signed, error: signedError } = await supabase.storage
        .from('feedback-screenshots')
        .createSignedUrl(r.screenshot_path, 30 * 24 * 60 * 60);
      screenshot = signedError || !signed?.signedUrl ? 'privater Screenshot nicht (mehr) abrufbar' : signed.signedUrl;
    }
    write(`### feedback:${r.id}`);
    write(`Original: ${r.message}`);
    write(`Kontext/Screenshot: ${line(r.page_context)} · ${screenshot}`);
    for (const l of timeline(r)) write(l);
    write('');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
}
