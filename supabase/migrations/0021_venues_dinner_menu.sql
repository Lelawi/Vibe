-- Abendkarte/allgemeine Speisekarte, analog zu lunch_menu_url (0017) — siehe
-- Kommentar bei extractDinnerMenuUrl() in collectors/core/venues.ts für die
-- Begründung, warum es (anders als beim Mittagslunch) kein zusätzliches
-- "verfügbar"-Boolean gibt, nur den Link.
alter table venues add column if not exists dinner_menu_url text;
