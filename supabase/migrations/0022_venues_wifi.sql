-- WLAN-Info aus dem OSM-Tag internet_access (siehe collectors/core/venues.ts)
-- -- null bedeutet "unbekannt", nicht "kein WLAN".
alter table venues add column if not exists wifi boolean;
