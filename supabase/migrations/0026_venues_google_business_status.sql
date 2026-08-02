-- Googles businessStatus (OPERATIONAL / CLOSED_TEMPORARILY /
-- CLOSED_PERMANENTLY) gehört zum selben "Enterprise"-Feld-Paket wie rating
-- (siehe collectors/sources/google-ratings/index.ts) — kein Mehrpreis, da
-- der Aufruf ohnehin schon im teuersten Tier abgerechnet wird. Dient der
-- Closure-Review-Routine als zusätzliches Signal neben der freien
-- Web-Recherche.
alter table venues add column if not exists google_business_status text;
