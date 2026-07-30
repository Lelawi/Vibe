-- OSM pflegt bei amenity=restaurant häufig einen cuisine-Tag (per Direktabruf
-- verifiziert, 2026-07: 1814 von 2263 Münchner Restaurants, ~80%) — genutzt
-- für ein Küchen-Badge und einen Schnellfilter auf dem Restaurants-Screen.
alter table venues add column if not exists cuisine text;
