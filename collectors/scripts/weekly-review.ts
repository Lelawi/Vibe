import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../app/.env') });

const line = (value: unknown) => value == null || value === '' ? '—' : String(value);
const date = (value: string) => new Date(value).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });

export async function run(write: (value: string) => void = console.log): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { write('[weekly-review] Supabase-Umgebung fehlt'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const [closuresResult, venueReportsResult, eventReportsResult, appFeedbackResult, missingResult] = await Promise.all([
    supabase.from('venue_closure_reports').select('venue_id,reported_at,status,analysis_status,analysis_summary,analysis_confidence,analysis_evidence').eq('status', 'pending').eq('analysis_status', 'manual_review').order('reported_at'),
    supabase.from('venue_reports').select('id,venue_id,reason,note,created_at,status,analysis_status,analysis_summary,analysis_confidence,analysis_evidence').eq('status', 'pending').eq('analysis_status', 'manual_review').order('created_at'),
    supabase.from('event_reports').select('id,event_id,reason,note,created_at,status,analysis_status,analysis_summary,analysis_confidence,analysis_evidence').eq('status', 'pending').eq('analysis_status', 'manual_review').order('created_at'),
    supabase.from('app_feedback').select('id,message,screenshot_path,page_context,created_at,status,analysis_status,analysis_category,analysis_summary,analysis_confidence,analysis_evidence').eq('status', 'new').eq('analysis_status', 'manual_review').order('created_at'),
    supabase.from('missing_items').select('id,kind,name,event_date,location,source_url,note,page_context,created_at,status,analysis_status,analysis_summary,analysis_confidence,analysis_evidence').eq('status', 'new').eq('analysis_status', 'manual_review').order('created_at'),
  ]);
  for (const result of [closuresResult, venueReportsResult, eventReportsResult, appFeedbackResult, missingResult]) {
    if (result.error) throw result.error;
  }

  const closures = closuresResult.data ?? [];
  const venueReports = venueReportsResult.data ?? [];
  const eventReports = eventReportsResult.data ?? [];
  const appFeedback = appFeedbackResult.data ?? [];
  const missing = missingResult.data ?? [];
  const venueIds = [...new Set([...closures.map((row) => row.venue_id), ...venueReports.map((row) => row.venue_id)])];
  const eventIds = [...new Set(eventReports.map((row) => row.event_id))];
  const { data: venues, error: venuesError } = venueIds.length
    ? await supabase.from('venues').select('id,name,name_override,type,address,website,opening_hours_raw,opening_hours_override,google_opening_hours,beer_price_eur,google_business_status,google_rating_checked_at,google_not_found_streak').in('id', venueIds)
    : { data: [], error: null };
  const { data: events, error: eventsError } = eventIds.length
    ? await supabase.from('events').select('id,title,start_date,start_time,location_name,source_url').in('id', eventIds)
    : { data: [], error: null };
  if (venuesError) throw venuesError;
  if (eventsError) throw eventsError;
  const venueById = new Map((venues ?? []).map((venue) => [venue.id, venue]));
  const eventById = new Map((events ?? []).map((event) => [event.id, event]));

  // Identische Mehrfachmeldungen sind ein Entscheidungspunkt. Die einzelnen
  // IDs bleiben sichtbar, damit bei der Entscheidung alle Zeilen gemeinsam
  // abgeschlossen werden können.
  const groupedVenueReports = [...venueReports.reduce((groups, report) => {
    const key = [report.venue_id, report.reason?.trim().toLocaleLowerCase('de-DE'), report.note?.trim().toLocaleLowerCase('de-DE')].join('|');
    const existing = groups.get(key);
    if (existing) existing.push(report);
    else groups.set(key, [report]);
    return groups;
  }, new Map<string, typeof venueReports>()).values()];

  const total = closures.length + groupedVenueReports.length + eventReports.length + appFeedback.length + missing.length;
  write(`# Vibe-Wochenreview\n`);
  write(`Offene Entscheidungen: **${total}** · erstellt ${date(new Date().toISOString())}\n`);

  write(`## 1. Als geschlossen gemeldete Locations (${closures.length})\n`);
  for (const report of closures) {
    const venue = venueById.get(report.venue_id);
    write(`### closure:${report.venue_id} — ${venue?.name_override ?? venue?.name ?? report.venue_id}`);
    write(`- Typ/Adresse: ${line(venue?.type)} · ${line(venue?.address)}`);
    write(`- Website: ${line(venue?.website)}`);
    write(`- Google-Status: ${line(venue?.google_business_status)} (zuletzt ${venue?.google_rating_checked_at ? date(venue.google_rating_checked_at) : '—'})`);
    write(`- Vorprüfung: ${line(report.analysis_summary)} · Status ${line(report.analysis_status)} · Konfidenz ${line(report.analysis_confidence)}`);
    write(`- Gemeldet: ${date(report.reported_at)}\n`);
  }

  write(`## 2. Bierpreise und andere Venue-Daten (${groupedVenueReports.length})\n`);
  for (const reports of groupedVenueReports) {
    const report = reports[0];
    const venue = venueById.get(report.venue_id);
    write(`### venue:${report.id} — ${venue?.name_override ?? venue?.name ?? report.venue_id}`);
    if (reports.length > 1) write(`- ${reports.length} gleichlautende Meldungen: ${reports.map((row) => row.id).join(', ')}`);
    write(`- Meldung: ${line(report.reason)} · ${line(report.note)}`);
    write(`- Aktuell: Bierpreis ${line(venue?.beer_price_eur)} € · Öffnungszeiten ${line(venue?.opening_hours_override ?? venue?.google_opening_hours ?? venue?.opening_hours_raw)}`);
    write(`- Website: ${line(venue?.website)}`);
    write(`- Vorprüfung: ${line(report.analysis_summary)} · Status ${line(report.analysis_status)} · Konfidenz ${line(report.analysis_confidence)}`);
    const received = reports.map((row) => date(row.created_at));
    write(`- Eingegangen: ${received.join(' und ')}\n`);
  }

  write(`## 3. Fehlerhafte Eventdaten (${eventReports.length})\n`);
  for (const report of eventReports) {
    const event = eventById.get(report.event_id);
    write(`### event:${report.id} — ${event?.title ?? report.event_id}`);
    write(`- Meldung: ${line(report.reason)} · ${line(report.note)}`);
    write(`- Aktuell: ${line(event?.start_date)} ${line(event?.start_time)} · ${line(event?.location_name)}`);
    write(`- Vorprüfung: ${line(report.analysis_summary)} · Status ${line(report.analysis_status)} · Konfidenz ${line(report.analysis_confidence)}`);
    write(`- Quelle: ${line(event?.source_url)} · eingegangen ${date(report.created_at)}\n`);
  }

  write(`## 4. Fehlende Events oder Locations (${missing.length})\n`);
  for (const report of missing) {
    write(`### missing:${report.id} — [${report.kind}] ${report.name}`);
    write(`- Datum/Ort: ${line(report.event_date)} · ${line(report.location)}`);
    write(`- Quelle/Notiz: ${line(report.source_url)} · ${line(report.note)}`);
    write(`- Vorprüfung: ${line(report.analysis_summary)} · Status ${line(report.analysis_status)} · Konfidenz ${line(report.analysis_confidence)}`);
    write(`- Kontext: ${line(report.page_context)} · eingegangen ${date(report.created_at)}\n`);
  }

  write(`## 5. Sonstiges App-Feedback (${appFeedback.length})\n`);
  for (const report of appFeedback) {
    let screenshot = '—';
    if (report.screenshot_path) {
      const { data: signed, error: signedError } = await supabase.storage
        .from('feedback-screenshots')
        .createSignedUrl(report.screenshot_path, 8 * 24 * 60 * 60);
      screenshot = signedError || !signed?.signedUrl ? 'privater Screenshot nicht abrufbar' : signed.signedUrl;
    }
    write(`### feedback:${report.id}`);
    write(`- Original: ${report.message}`);
    write(`- KI-Vorprüfung: ${line(report.analysis_summary)} · Kategorie ${line(report.analysis_category)} · Konfidenz ${line(report.analysis_confidence)}`);
    write(`- Kontext/Screenshot: ${line(report.page_context)} · ${screenshot}`);
    write(`- Eingegangen: ${date(report.created_at)}\n`);
  }

  write('## Entscheidungsregel');
  write('- **Bestätigen/umsetzen:** Änderung ausführen und Eintrag abschließen.');
  write('- **Ablehnen:** mit kurzer Begründung abschließen.');
  write('- **Offen lassen:** erscheint im nächsten Wochenreview erneut. Fehlende Online-Belege sind kein Ablehnungsgrund.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
}
