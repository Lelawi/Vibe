-- Web-Push-Infrastruktur für Erinnerungen an Favoriten und Benachrichtigungen
-- bei neuen Events, die zu gespeicherten Filtern passen. Die App hat kein
-- Login (nur anon key), daher gibt es keinen "Nutzer" im klassischen Sinn —
-- ein Gerät wird ausschließlich über seinen Push-Subscription-Endpoint
-- identifiziert. subscription_id (zufällige UUID) fungiert dadurch faktisch
-- als unratbares Zugriffstoken für die eigenen Zeilen in push_favorites/
-- push_filters; das ist für dieses Datenmodell (keine sensiblen Daten außer
-- einer Push-Endpoint-URL) ein bewusst akzeptierter Trade-off statt echter
-- Row-Level-Auth.

create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  endpoint text unique not null,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

create table if not exists push_favorites (
  subscription_id uuid not null references push_subscriptions(id) on delete cascade,
  event_id uuid not null references events(id) on delete cascade,
  -- gesetzt sobald die Erinnerung verschickt wurde, verhindert Doppel-Versand
  notified_at timestamptz,
  primary key (subscription_id, event_id)
);

create table if not exists push_filters (
  subscription_id uuid primary key references push_subscriptions(id) on delete cascade,
  categories text[] not null default '{}',
  genres text[] not null default '{}',
  locations text[] not null default '{}',
  -- Zeitpunkt der letzten erfolgreichen Prüfung auf neue passende Events,
  -- damit der Sender nur Events berücksichtigt, die seither hinzugekommen sind
  last_checked_at timestamptz not null default now()
);

alter table push_subscriptions enable row level security;
alter table push_favorites enable row level security;
alter table push_filters enable row level security;

drop policy if exists "anon can create push subscription" on push_subscriptions;
create policy "anon can create push subscription"
  on push_subscriptions for insert
  to anon
  with check (true);

drop policy if exists "anon can manage push favorites" on push_favorites;
create policy "anon can manage push favorites"
  on push_favorites for all
  to anon
  using (true)
  with check (true);

drop policy if exists "anon can manage push filters" on push_filters;
create policy "anon can manage push filters"
  on push_filters for all
  to anon
  using (true)
  with check (true);

-- Kein select/update/delete auf push_subscriptions für anon: der Client
-- braucht die Zeile nur einmalig beim Anlegen (liefert die id per RETURNING
-- zurück), danach genügt push_favorites/push_filters. Der Sender läuft mit
-- dem Service-Role-Key und ist von RLS ohnehin nicht betroffen.
