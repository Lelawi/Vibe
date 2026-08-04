-- Discovery-Ausbau: benannte Push-Suchen, nachvollziehbare Event-
-- Änderungen/Quellenaktualität und ein vorsichtig kuratiertes Künstlermodell.

create table if not exists push_saved_searches (
  id uuid primary key,
  subscription_id uuid not null references push_subscriptions(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  categories text[] not null default '{}',
  genres text[] not null default '{}',
  locations text[] not null default '{}',
  date_filter text not null default 'all'
    check (date_filter in ('all', 'today', 'tomorrow', 'week', 'weekend')),
  free_only boolean not null default false,
  available_only boolean not null default true,
  enabled boolean not null default false,
  last_checked_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  check (
    cardinality(categories) > 0 or cardinality(genres) > 0 or
    cardinality(locations) > 0 or date_filter <> 'all' or free_only
  )
);
create index if not exists push_saved_searches_subscription_idx on push_saved_searches(subscription_id);
alter table push_saved_searches enable row level security;
drop policy if exists "anon can manage saved searches" on push_saved_searches;
create policy "anon can manage saved searches" on push_saved_searches
  for all to anon using (true) with check (true);

-- Bestehende Alt-Datensätze starten mit NULL: der Migrationszeitpunkt darf
-- nicht fälschlich als echte Quellenprüfung erscheinen. Neue Inserts erhalten
-- dagegen sofort einen Prüfzeitpunkt; bestehende Zeilen beim nächsten Upsert.
alter table events add column if not exists source_checked_at timestamptz;
alter table events alter column source_checked_at set default now();
alter table events add column if not exists last_changed_at timestamptz;

create table if not exists event_changes (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  changed_fields text[] not null,
  old_values jsonb not null,
  new_values jsonb not null,
  created_at timestamptz not null default now(),
  notified_at timestamptz
);
create index if not exists event_changes_pending_idx
  on event_changes(created_at) where notified_at is null;
create index if not exists event_changes_event_idx on event_changes(event_id, created_at desc);
alter table event_changes enable row level security;
drop policy if exists "public can read event changes" on event_changes;
create policy "public can read event changes" on event_changes for select using (true);

create or replace function public.prepare_event_source_update()
returns trigger language plpgsql as $$
begin
  new.source_checked_at := now();
  if row(
    new.start_date, new.start_time, new.end_date, new.location_name,
    new.address, new.price_info, new.sold_out, new.source_url
  ) is distinct from row(
    old.start_date, old.start_time, old.end_date, old.location_name,
    old.address, old.price_info, old.sold_out, old.source_url
  ) then
    new.last_changed_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists prepare_event_source_update_trigger on events;
create trigger prepare_event_source_update_trigger
  before update on events for each row execute function public.prepare_event_source_update();

create or replace function public.record_event_change()
returns trigger language plpgsql as $$
declare
  fields text[] := '{}';
  old_data jsonb;
  new_data jsonb;
begin
  if new.start_date is distinct from old.start_date then fields := array_append(fields, 'start_date'); end if;
  if new.start_time is distinct from old.start_time then fields := array_append(fields, 'start_time'); end if;
  if new.end_date is distinct from old.end_date then fields := array_append(fields, 'end_date'); end if;
  if new.location_name is distinct from old.location_name then fields := array_append(fields, 'location_name'); end if;
  if new.address is distinct from old.address then fields := array_append(fields, 'address'); end if;
  if new.price_info is distinct from old.price_info then fields := array_append(fields, 'price_info'); end if;
  if new.sold_out is distinct from old.sold_out then fields := array_append(fields, 'sold_out'); end if;
  if new.source_url is distinct from old.source_url then fields := array_append(fields, 'source_url'); end if;
  if cardinality(fields) = 0 then return new; end if;

  old_data := jsonb_build_object(
    'start_date', old.start_date, 'start_time', old.start_time, 'end_date', old.end_date,
    'location_name', old.location_name, 'address', old.address,
    'price_info', old.price_info, 'sold_out', old.sold_out, 'source_url', old.source_url
  );
  new_data := jsonb_build_object(
    'start_date', new.start_date, 'start_time', new.start_time, 'end_date', new.end_date,
    'location_name', new.location_name, 'address', new.address,
    'price_info', new.price_info, 'sold_out', new.sold_out, 'source_url', new.source_url
  );
  insert into event_changes(event_id, changed_fields, old_values, new_values)
    values (new.id, fields, old_data, new_data);
  return new;
end;
$$;

drop trigger if exists record_event_change_trigger on events;
create trigger record_event_change_trigger
  after update on events for each row execute function public.record_event_change();

create table if not exists artists (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  normalized_name text not null unique,
  created_at timestamptz not null default now()
);
create table if not exists event_artists (
  event_id uuid not null references events(id) on delete cascade,
  artist_id uuid not null references artists(id) on delete cascade,
  source text not null,
  confidence text not null default 'structured' check (confidence in ('structured', 'curated')),
  created_at timestamptz not null default now(),
  primary key (event_id, artist_id)
);
create index if not exists event_artists_artist_idx on event_artists(artist_id, created_at desc);
alter table artists enable row level security;
alter table event_artists enable row level security;
drop policy if exists "public can read artists" on artists;
create policy "public can read artists" on artists for select using (true);
drop policy if exists "public can read event artists" on event_artists;
create policy "public can read event artists" on event_artists for select using (true);

create table if not exists push_artist_follows (
  subscription_id uuid not null references push_subscriptions(id) on delete cascade,
  artist_id uuid not null references artists(id) on delete cascade,
  last_checked_at timestamptz not null default now(),
  primary key (subscription_id, artist_id)
);
alter table push_artist_follows enable row level security;
drop policy if exists "anon can manage artist follows" on push_artist_follows;
create policy "anon can manage artist follows" on push_artist_follows
  for all to anon using (true) with check (true);
