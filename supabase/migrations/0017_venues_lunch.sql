-- Mittagslunch-Filter für Restaurants: von der eigenen Website gescrapt
-- (Mittagskarte-Link oder Erwähnung im Fließtext, siehe extractLunchSignal in
-- collectors/core/venues.ts) — bewusst NICHT aus Google-Reviews/Kommentaren,
-- dafür gibt es keine freie, ToS-konforme Quelle.
alter table venues add column if not exists lunch_available boolean not null default false;
alter table venues add column if not exists lunch_menu_url text;
