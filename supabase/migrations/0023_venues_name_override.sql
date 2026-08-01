-- Manueller Namens-Override für Venues, deren OSM-Tag veraltet ist (z.B. eine
-- Bar wurde umbenannt, aber niemand hat den OSM-Knoten aktualisiert). Der
-- Collector schreibt `name` bei jedem Lauf frisch aus dem OSM-Tag — diese
-- Spalte wird dort absichtlich nie angefasst, bleibt also über jeden
-- automatischen Lauf hinweg erhalten. Gleiches Prinzip wie
-- opening_hours_override.
alter table venues add column if not exists name_override text;
