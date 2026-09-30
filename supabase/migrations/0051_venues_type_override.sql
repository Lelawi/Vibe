-- Manuell korrigierte Venue-Kategorie (z.B. Nutzerhinweis "ist glaube ich
-- keine Bar", im Wochenbericht als Restaurant bestätigt). Gleiches Muster
-- wie name_override (0023) / opening_hours_override (0014): type bleibt die
-- Spalte, nach der die App filtert, type_override hält die manuelle
-- Entscheidung fest. Ohne sie hätte der wöchentliche OSM-Lauf
-- (collectors/core/venues.ts) type jeden Montag wieder auf den OSM-Wert
-- zurückgesetzt — der Collector übernimmt type_override jetzt als type.
alter table venues add column if not exists type_override text
  check (type_override in ('bar', 'restaurant', 'spaeti'));
