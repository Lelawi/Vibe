-- Fix: "new row violates row-level security policy for table
-- push_subscriptions" beim Aktivieren von Push-Benachrichtigungen im
-- Web-Build. Migration 0005 hatte die Policies auf "to anon" beschränkt —
-- mit dem neuen sb_publishable_-Key-Format (siehe app/.env,
-- EXPO_PUBLIC_SUPABASE_ANON_KEY) matcht die Anfrage aber offenbar nicht
-- zuverlässig die Postgres-Rolle "anon", während die bestehende, seit
-- Projektbeginn funktionierende "public read access"-Policy auf `events`
-- gar keine Rollen-Einschränkung hat (nur `using (true)`). Entfernt daher
-- die Rollen-Einschränkung bei allen drei Push-Tabellen — der eigentliche
-- Zugriffsschutz kommt ohnehin nicht aus der Rolle, sondern aus der
-- Kombination "kein select auf push_subscriptions" + "subscription_id als
-- unratbares Zugriffstoken" (siehe Kommentare in 0005).
drop policy if exists "anon can create push subscription" on push_subscriptions;
create policy "anyone can create push subscription"
  on push_subscriptions for insert
  with check (true);

drop policy if exists "anon can manage push favorites" on push_favorites;
create policy "anyone can manage push favorites"
  on push_favorites for all
  using (true)
  with check (true);

drop policy if exists "anon can manage push filters" on push_filters;
create policy "anyone can manage push filters"
  on push_filters for all
  using (true)
  with check (true);
