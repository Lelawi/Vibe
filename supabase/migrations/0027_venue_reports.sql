-- Nutzer-Meldungen zu falschen/fehlenden Venue-Daten (Öffnungszeiten,
-- Bierpreis, veraltete Infos etc.) — Pendant zu event_reports (0003) für
-- Bars/Restaurants/Spätis. Bewusst getrennt von venue_closure_reports
-- (0012ff): dort läuft ein eigener Status-Workflow (pending/confirmed/
-- rejected) für "existiert nicht mehr" inkl. automatischer Review-Routine;
-- hier reicht "insert-only, manuell geprüft" wie bei event_reports, da noch
-- keine Automatisierung dafür existiert.
create table if not exists venue_reports (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  reason text,
  note text,
  created_at timestamptz not null default now()
);

alter table venue_reports enable row level security;

create policy "anyone can report venue data issues"
  on venue_reports for insert
  with check (true);
