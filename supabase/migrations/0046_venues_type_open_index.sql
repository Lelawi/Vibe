-- Analog zu 0045 (events): fetchAllVenues.ts (app/lib/fetchAllVenues.ts)
-- filtert bei jedem Öffnen der Bars-/Restaurants-Tabs auf
--   type = <bar|restaurant|spaeti> AND closed_at IS NULL
-- sortiert nach id, wieder in bis zu mehreren parallelen 1000er-Seiten. Ohne
-- passenden Index behilft sich Postgres aktuell mit dem PK-Index (id), der
-- zufällig schon die richtige Sortierung liefert, und filtert den Rest
-- (per EXPLAIN ANALYZE verifiziert, 2026-08-13: noch schnell bei 4.145
-- Zeilen, aber derselbe strukturelle Fehlbetrag wie bei events vor 0045 —
-- venues ist von 2263 Restaurants/581 Bars beim ursprünglichen fetchAllVenues-
-- Kommentar auf inzwischen 3.120/507/375 (+spaeti) gewachsen und wächst
-- weiter). Vorbeugend behoben, bevor es wie bei events erst auffällt.
create index if not exists venues_open_by_type_idx
  on venues (type, id)
  where closed_at is null;
