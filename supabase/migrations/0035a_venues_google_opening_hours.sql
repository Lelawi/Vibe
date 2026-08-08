-- (2026-08-08 auf "0035a" umbenannt: zwei unabhängige Migrationen wurden am
-- selben Tag versehentlich beide als "0035" angelegt, siehe 0035b. Beide
-- waren zu diesem Zeitpunkt bereits produktiv angewendet, daher nur
-- Umbenennung zur Klarstellung, keine neue Anwendung nötig.)
--
-- Google-Öffnungszeiten getrennt von Website- und OSM-Daten speichern,
-- damit die App eine nachvollziehbare Quellenpriorität anwenden kann:
-- Betreiber-Website > Google Places > OpenStreetMap.
alter table venues add column if not exists google_opening_hours text;
alter table venues add column if not exists google_opening_hours_checked_at timestamptz;

comment on column venues.google_opening_hours is
  'Reguläre Öffnungszeiten aus Google Places, normalisiert in OSM-Syntax; Website-Override hat Vorrang.';

comment on column venues.google_opening_hours_checked_at is
  'Letzte Google-Prüfung der regulären Öffnungszeiten; unterscheidet fehlende Zeiten von noch nicht migrierten Datensätzen.';
