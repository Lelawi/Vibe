-- Zählt, an wie vielen separaten Tagen der google-ratings-Collector diese
-- Venue nicht bei Google finden/zuordnen konnte (looksLikeSameVenue-
-- Ablehnung oder gar kein Kandidat), in Folge. Ein einzelner "nicht
-- gefunden"-Tag ist kein verlässliches Signal (Google übersieht auch mal
-- echte, offene Läden), aber mehrere Tage in Folge bei einer täglich neu
-- geprüften, gemeldeten Venue schon eher — die Closure-Review-Routine nutzt
-- das als zusätzliches Kriterium, um Kleinst-Venues ohne jede Web-Präsenz
-- (siehe Titta's-Fall, 2026-08-03) nicht endlos in "pending" hängen zu
-- lassen, ohne bei einem einmaligen Google-Aussetzer voreilig zu bestätigen.
alter table venues add column if not exists google_not_found_streak integer not null default 0;
