-- Strukturierte Nutzereinreichungen für Events oder Locations, die noch
-- nicht in Vibe vorkommen. Getrennt von app_feedback (freie Bug-/Ideentexte),
-- damit Datum, Ort und Quell-URL später gezielt geprüft werden können.
create table if not exists missing_items (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('event', 'location')),
  name text not null,
  event_date date,
  location text,
  source_url text,
  note text,
  page_context text,
  created_at timestamptz not null default now(),
  status text not null default 'new' check (status in ('new', 'reviewed'))
);

alter table missing_items enable row level security;

drop policy if exists "anon can submit missing items" on missing_items;
create policy "anon can submit missing items" on missing_items
  for insert to anon with check (status = 'new');
