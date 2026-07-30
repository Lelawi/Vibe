-- OSM-opening_hours-Tags sind gelegentlich ungenau/veraltet (z.B. Alter
-- Simpl: OSM sagt "Mo-We 11:00-00:00...", tatsächliches Türschild sagt
-- "Mo-Mi 11:30-00:00..."). Statt uns auf OSM zu verlassen, wo eine Bar-
-- Website eigene, vom Betreiber gepflegte schema.org-Öffnungszeiten
-- (openingHours/openingHoursSpecification) veröffentlicht, wird dieser
-- override genutzt (siehe collectors/sources/bars/index.ts).
alter table bars add column if not exists opening_hours_override text;
