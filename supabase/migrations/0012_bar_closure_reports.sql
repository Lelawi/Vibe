-- Es gibt keine automatisierte, freie Möglichkeit zu erkennen, ob eine
-- OSM-gepflegte Bar tatsächlich noch existiert (OSM-Daten können veraltet
-- sein, ohne dass ein disused:amenity-Tag gesetzt wurde). Stattdessen können
-- Nutzer:innen eine Bar direkt in der App als "gibt's nicht mehr" melden —
-- die Bar wird dann clientseitig aus Liste und Karte ausgeblendet. Ein
-- erneuter wöchentlicher Collector-Lauf (collectors/sources/bars) behält
-- dieselbe id (Upsert per osm_id-Konflikt), die Meldung bleibt also über den
-- FK gültig, statt beim nächsten Lauf zu verschwinden.
create table if not exists bar_closure_reports (
  bar_id uuid primary key references bars(id) on delete cascade,
  reported_at timestamptz not null default now()
);

alter table bar_closure_reports enable row level security;

drop policy if exists "public read access" on bar_closure_reports;
create policy "public read access"
  on bar_closure_reports for select
  using (true);

drop policy if exists "anon can report a bar as closed" on bar_closure_reports;
create policy "anon can report a bar as closed"
  on bar_closure_reports for insert
  to anon
  with check (true);
