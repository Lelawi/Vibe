-- Google-Bewertungen für Venues, rollierend über die Places API (New)
-- abgefragt (siehe collectors/sources/google-ratings/index.ts) — bewusst NICHT
-- gescrapt, um Googles Nutzungsbedingungen einzuhalten. google_place_id wird
-- einmalig per Text Search aufgelöst und danach wiederverwendet, damit nur
-- noch der günstigere Place-Details-Call (der eigentliche Kostenfaktor)
-- nötig ist. google_rating_checked_at steuert die monatliche Rotation
-- (älteste zuerst) und das Monatsbudget (siehe Kommentar im Collector).
alter table venues add column if not exists google_place_id text;
alter table venues add column if not exists google_rating numeric;
alter table venues add column if not exists google_rating_count integer;
alter table venues add column if not exists google_rating_checked_at timestamptz;
