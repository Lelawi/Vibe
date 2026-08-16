-- Public-Read-Bucket fuer einmalig von der Google Places Photos API
-- heruntergeladene und selbst gehostete Venue-Fotos (Bars/Restaurants/
-- Spaetis ohne eigene Website, siehe collectors/scripts/backfill-google-
-- photos-onetime.ts). Google erlaubt explizit KEIN dauerhaftes Zwischen-
-- speichern der von der API zurueckgegebenen photoUri ("you cannot cache a
-- photo name... the name can expire") -- deshalb einmalig herunterladen und
-- selbst hosten statt die Google-URL direkt in venues.image_url zu
-- speichern, sonst wuerden diese Bilder nach unbestimmter Zeit lautlos
-- kaputtgehen (aehnlicher Fehlermodus wie der Scroll-Sprung-Bug bei
-- fehlgeschlagenen Bildern, siehe VenueListScreen.tsx-Fix 2026-08-16).
-- Nur die Collector-Skripte (service_role, umgeht RLS ohnehin) schreiben
-- hier rein; kein Insert/Update fuer anon noetig. Public=true, damit die
-- App die Bild-URLs direkt laden kann, ohne signierte URLs ausstellen zu
-- muessen (gleiches Muster wie 0025_app_feedback.sql fuer
-- feedback-screenshots).
insert into storage.buckets (id, name, public)
  values ('venue-photos', 'venue-photos', true)
  on conflict (id) do nothing;
