-- Restaurants sollen dieselbe Grundfunktion wie Bars bekommen (Öffnungszeiten,
-- Bilder, Karte, "gibt's nicht mehr"-Meldung) -- statt einer komplett
-- parallelen Struktur (eigene Tabelle, eigener Collector, eigene
-- closure_reports) wird die bestehende bars-Tabelle zu einer generischen
-- venues-Tabelle mit einer type-Spalte erweitert. Bars und Restaurants teilen
-- sich damit Schema, RLS-Policies, Öffnungszeiten-Parsing und die Melde-
-- Funktion (siehe collectors/sources/bars, collectors/sources/restaurants).
alter table bars rename to venues;
alter table venues add column if not exists type text not null default 'bar' check (type in ('bar', 'restaurant'));

alter table bar_closure_reports rename to venue_closure_reports;
alter table venue_closure_reports rename column bar_id to venue_id;
