-- Ergänzende Spalten für Deduplizierung und Standort
alter table events add column if not exists source_id text unique;
alter table events add column if not exists latitude double precision;
alter table events add column if not exists longitude double precision;

-- Zugriffsschutz: Jeder darf lesen, niemand darf über die App schreiben
alter table events enable row level security;

drop policy if exists "public read access" on events;

create policy "public read access"
  on events for select
  using (true);
