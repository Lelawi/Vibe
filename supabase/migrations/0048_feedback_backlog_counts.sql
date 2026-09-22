-- Fund (2026-09-22, wöchentliche Feedback-Rückstau-Routine): die geplante
-- Wochenzusammenfassung über venue_closure_reports/venue_reports/
-- event_reports/missing_items/app_feedback lief mit dem anon-key (aus
-- gutem Grund, siehe 0020/0037-Kommentare: kein service_role in dieser
-- Cloud-Umgebung) und lieferte für 3 der 5 Tabellen strukturell falsche
-- Nullen statt echter Zählwerte:
--   - venue_reports/event_reports sind für anon komplett insert-only
--     (siehe 0003/0027 — "Reports werden über das Dashboard (service role)
--     eingesehen, nicht über die App selbst"), keine SELECT-Policy
--     existiert, jede Abfrage liefert [] unabhängig vom echten Bestand.
--   - missing_items ist ebenfalls insert-only für anon (0029) und hat
--     zusätzlich gar keinen 'pending'-Status (nur 'new'/'reviewed').
--   - venue_closure_reports/app_feedback sind seit 0037 nur im Ausschnitt
--     analysis_status='manual_review' für anon sichtbar — ein "pending"-
--     Query über den vollen Bestand liefert nur die Schnittmenge, nicht
--     die echte Warteschlange.
-- Genau das Muster aus 0037 ("beide Routinen meldeten '0 zu prüfen', ohne
-- dass das der tatsächliche Stand der Warteschlange war") wiederholt sich
-- hier für die neue wöchentliche Routine.
--
-- Lösung nach demselben engen Muster wie venue_closure_statuses (0034) und
-- submit_venue_closure_report() (0034): keine breite SELECT-Freigabe auf
-- die Tabellen (die Reporttexte/-Notizen bleiben bewusst privat, siehe
-- 0003/0025/0027/0029-Begründungen), sondern eine einzelne
-- security-definer-Funktion, die ausschließlich aggregierte Zählwerte ohne
-- jeglichen Zeileninhalt zurückgibt.
create or replace function public.get_feedback_backlog_counts()
returns table (table_name text, open_count bigint)
language sql
security definer
set search_path = public
stable
as $function$
  select 'venue_closure_reports'::text, count(*) from venue_closure_reports where status = 'pending'
  union all
  select 'venue_reports'::text, count(*) from venue_reports where status = 'pending'
  union all
  select 'event_reports'::text, count(*) from event_reports where status = 'pending'
  union all
  select 'missing_items'::text, count(*) from missing_items where status = 'new'
  union all
  select 'app_feedback'::text, count(*) from app_feedback where status = 'new';
$function$;

revoke all on function public.get_feedback_backlog_counts() from public;
grant execute on function public.get_feedback_backlog_counts() to anon, authenticated;

comment on function public.get_feedback_backlog_counts() is
  'Liefert nur aggregierte Zählwerte (kein Zeileninhalt) je Feedback-/Report-Tabelle, damit die wöchentliche Rückstau-Routine mit dem anon-key echte Gesamtzahlen statt RLS-bedingter Nullen bekommt. Reporttexte/-notizen bleiben weiterhin nur über service_role einsehbar.';
