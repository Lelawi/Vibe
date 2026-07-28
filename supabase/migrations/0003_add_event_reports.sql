-- Nutzer-Meldungen zu fehlerhaften Event-Daten (z.B. falsche Adresse wie beim
-- Import-Export-Fund). Schreibgeschützt für den Client: anon darf einfügen,
-- aber nicht lesen — Reports werden über das Supabase-Dashboard (service
-- role) eingesehen, nicht über die App selbst.
create table if not exists event_reports (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  reason text,
  note text,
  created_at timestamptz not null default now()
);

alter table event_reports enable row level security;

drop policy if exists "anyone can report" on event_reports;
create policy "anyone can report"
  on event_reports for insert
  with check (true);
