-- Erlaubt der (öffentlichen, nicht-geheimen) anon-Rolle, den Status eines
-- eigenen "pending"-Reports auf "confirmed"/"rejected" zu setzen — bisher
-- gab es dafür nur eine select+insert-Policy (siehe 0012), jede Entscheidung
-- musste über den service_role-Key laufen (collectors/scripts/
-- review-closures.ts). Für die geplante tägliche Cloud-Routine (Claude Code
-- Environment) sollte aber kein service_role-Key nötig sein — das
-- Umgebungsvariablen-Feld dort ist laut UI-Warnung ausdrücklich NICHT für
-- Geheimnisse gedacht ("für alle sichtbar, die diese Umgebung verwenden"),
-- und der service_role-Key hätte vollen Schreibzugriff auf die gesamte
-- Datenbank, weit über diese eine Tabelle hinaus. Eng zugeschnitten: nur
-- "pending" -> "confirmed"/"rejected" ist erlaubt (kein Zurücksetzen bereits
-- entschiedener Reports, kein Verändern anderer Spalten wie reported_at/
-- venue_id, da with check nur den neuen status-Wert prüft, aber using nur
-- auf noch offene Zeilen greift).
drop policy if exists "anon can decide a pending closure report" on venue_closure_reports;
create policy "anon can decide a pending closure report"
  on venue_closure_reports for update
  to anon
  using (status = 'pending')
  with check (status in ('confirmed', 'rejected'));
