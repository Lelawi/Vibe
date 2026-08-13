-- Die Haupt-Ladeabfrage der App (app/app/index.tsx, loadEvents) filtert bei
-- jedem Öffnen/Refresh auf
--   (start_date >= heute OR end_date >= heute) AND duplicate_of IS NULL
-- sortiert nach start_date, id — und zwar in bis zu 7 parallelen Seiten-
-- abfragen (Supabase deckelt jede Einzelabfrage hart bei 1000 Zeilen). Bisher
-- gab es auf events ausser dem Primary Key und dem Unique-Index auf
-- source_id KEINEN einzigen Index (per pg_indexes-Abfrage verifiziert,
-- 2026-08-13) — jede dieser parallelen Abfragen macht also einen vollen
-- Sequential Scan + Sort über die komplette Tabelle (8.867 Zeilen total,
-- 6.615 davon aktuell "kommend", täglich wachsend durch collect-all). Das
-- erklärt die zunehmend spürbaren Ladezeiten (per Nutzer-Feedback,
-- 2026-08-13: "die App wird relativ träge").
--
-- Zwei partielle Indizes statt einem einzigen kombinierten: die Abfrage ist
-- ein OR über zwei verschiedene Spalten (start_date/end_date) — Postgres
-- kann zwei getrennte Indizes per Bitmap-Or-Scan kombinieren, ein einzelner
-- zusammengesetzter Index könnte das OR dagegen nicht sauber unterstützen.
-- "where duplicate_of is null" filtert das jeweils andere Kriterium der
-- WHERE-Klausel direkt mit raus, statt es erst nach dem Scan anzuwenden, und
-- hält die Indizes zusätzlich kleiner (nur nicht-duplizierte Zeilen).
create index if not exists events_upcoming_by_start_idx
  on events (start_date, id)
  where duplicate_of is null;

create index if not exists events_upcoming_by_end_idx
  on events (end_date, id)
  where duplicate_of is null;
