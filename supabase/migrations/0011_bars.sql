-- Eigener "Bars"-Reiter (siehe app/app/bars.tsx): losgelöst von der
-- Events-Logik, weil eine Bar ein Ort mit regulären Öffnungszeiten ist,
-- kein einzelner Termin. Quelle ist OpenStreetMap/Overpass (kostenlos, kein
-- API-Key, amenity=bar/pub-Knoten in München sind zu ~67% mit einem
-- opening_hours-Tag gepflegt) statt eines neuen Ticketing-Collectors.
create table if not exists bars (
  id uuid primary key default gen_random_uuid(),
  -- OSM node id als stabiler Schlüssel für den Upsert-Konflikt.
  osm_id bigint unique not null,
  name text not null,
  address text,
  latitude double precision,
  longitude double precision,
  -- Roher OSM-opening_hours-String (z.B. "Mo-Sa 10:00-24:00; Su 10:00-23:00").
  -- Wird clientseitig geparst (app/lib/openingHours.ts), aber immer auch im
  -- Original angezeigt, falls der Parser eine Syntax-Variante nicht abdeckt.
  opening_hours_raw text,
  website text,
  phone text,
  updated_at timestamptz not null default now()
);

alter table bars enable row level security;

drop policy if exists "public read access" on bars;
create policy "public read access"
  on bars for select
  using (true);
