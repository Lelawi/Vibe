-- 0034 hat anon jeglichen Lese-/Schreibzugriff auf venue_closure_reports
-- entzogen (und Schreibzugriff auf app_feedback) und stattdessen eine
-- automatisierte Vorprüfung vorgesehen (analysis_status/analysis_summary/
-- analysis_evidence, siehe precheck-structured-reports.ts, läuft mit
-- service_role z.B. via .github/workflows/precheck-reports.yml). Das hat
-- aber übersehen, dass die beiden bestehenden Cloud-Routinen ("Vibe - Review
-- app feedback", "Vibe - Review of closure reports") bewusst NUR den
-- öffentlichen anon-Key nutzen (deren Umgebungsvariablen sind laut UI-
-- Warnung für jeden sichtbar, der die Umgebung verwendet — service_role
-- dort wäre ein zu weitreichendes Zugriffsrisiko). Seit 0034 laufen beide
-- Routinen täglich durch, ohne je etwas lesen oder entscheiden zu können —
-- live bestätigt am 2026-08-08 (beide Routinen meldeten "0 zu prüfen", ohne
-- dass das der tatsächliche Stand der Warteschlange war).
--
-- Lösung: anon darf NICHT die komplette Tabelle sehen/ändern (das wäre
-- wieder der alte, bewusst eingeschränkte Zustand vor 0034), sondern NUR
-- Zeilen, die die automatisierte Vorprüfung bereits durchlaufen und als
-- analysis_status = 'manual_review' eingestuft hat — also Fälle mit
-- gesammelter Evidenz, aber ohne sichere automatische Entscheidung. Rohe,
-- noch unanalysierte Meldungen (analysis_status = 'pending'/'processing')
-- bleiben für anon unsichtbar.

-- Policies allein reichen nicht: 0034 hat auch die Basis-Tabellenrechte
-- selbst per REVOKE entzogen (SELECT+INSERT+UPDATE bei venue_closure_reports,
-- UPDATE bei app_feedback) — RLS-Policies greifen nur zusätzlich zu, nie
-- anstelle eines fehlenden GRANT. Kein INSERT hier: neue Meldungen laufen
-- weiterhin ausschließlich über die security-definer-RPC
-- submit_venue_closure_report() bzw. die bestehende insert-Policy von
-- app_feedback, nicht über einen direkten Tabellen-INSERT.
grant select, update on venue_closure_reports to anon, authenticated;
grant update on app_feedback to anon, authenticated;

drop policy if exists "anon can read manual-review closure reports" on venue_closure_reports;
create policy "anon can read manual-review closure reports"
  on venue_closure_reports for select
  to anon, authenticated
  using (analysis_status = 'manual_review');

drop policy if exists "anon can decide a pending closure report" on venue_closure_reports;
create policy "anon can decide a pending closure report"
  on venue_closure_reports for update
  to anon, authenticated
  using (status = 'pending' and analysis_status = 'manual_review')
  with check (status in ('confirmed', 'rejected'));

drop policy if exists "anon can read manual-review feedback" on app_feedback;
create policy "anon can read manual-review feedback"
  on app_feedback for select
  to anon, authenticated
  using (analysis_status = 'manual_review');

drop policy if exists "anon can mark manual-review feedback reviewed" on app_feedback;
create policy "anon can mark manual-review feedback reviewed" on app_feedback
  for update
  to anon, authenticated
  using (status = 'new' and analysis_status = 'manual_review')
  with check (status = 'reviewed');
