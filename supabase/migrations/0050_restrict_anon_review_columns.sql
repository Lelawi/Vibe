-- Fund (2026-09-30, Code-Review): 0037 hat anon (= jeder mit dem öffentlich
-- im PWA-Bundle stehenden Key) ein UPDATE auf venue_closure_reports für
-- pending/manual_review-Fälle erlaubt — das Tabellen-Grant hatte aber keine
-- Spaltenliste. Damit ließ sich auch venue_id umschreiben und der Fall auf
-- 'confirmed' setzen; der Trigger sync_venue_closed_at blendete dann eine
-- BELIEBIGE Venue aus der App aus. Dasselbe offene Grant galt für
-- app_feedback (message, page_context, screenshot_path überschreibbar).
--
-- Fix: UPDATE für anon/authenticated nur noch auf die Spalten, die die
-- Review-Routinen laut docs/claude-routine-prompts.md tatsächlich schreiben
-- (Status, Notiz, Analyse-Felder). Identitäts- und Inhaltsspalten
-- (venue_id, reported_at, message, …) sind nicht mehr änderbar. Die RLS-
-- Policies aus 0037 bleiben unverändert.
--
-- Bekannte Restlücke (bewusst hier nicht gelöst): wer den anon-Key hat,
-- kann weiterhin einen der aktuell offenen manual_review-Fälle bestätigen
-- und damit genau DIESE Venue ausblenden. Sauber lösbar nur mit einem
-- eigenen Routine-Zugang statt anon (siehe Review-Bericht).

revoke update on public.venue_closure_reports from anon, authenticated;
grant update (
  status, review_note, reviewed_at,
  analysis_status, analysis_category, analysis_summary, analysis_confidence,
  analysis_evidence, analyzed_at, analysis_error, analysis_attempts
) on public.venue_closure_reports to anon, authenticated;

revoke update on public.app_feedback from anon, authenticated;
grant update (
  status, review_note, reviewed_at,
  analysis_status, analysis_category, analysis_summary, analysis_confidence,
  analysis_evidence, analyzed_at, analysis_error, analysis_attempts
) on public.app_feedback to anon, authenticated;
