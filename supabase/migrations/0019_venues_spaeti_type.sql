-- Vierter Venue-Typ neben bar/restaurant: Spätis (Kioske/Convenience-Shops
-- mit spätem/durchgehendem Verkauf) für die spontane "wo ist der nächste
-- Späti"-Suche unterwegs (siehe collectors/sources/spaetis). Quelle ist wie
-- bei Bars/Restaurants OSM/Overpass, allerdings über den shop=-Tag statt
-- amenity= (kiosk/convenience/alcohol), da Kioske in OSM als Shop und nicht
-- als Amenity klassifiziert werden.
alter table venues drop constraint if exists venues_type_check;
alter table venues add constraint venues_type_check check (type in ('bar', 'restaurant', 'spaeti'));
