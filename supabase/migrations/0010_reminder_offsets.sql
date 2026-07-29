-- Favoriten-Erinnerungen liefen bisher fix 3h vor Event-Beginn, ohne dass die
-- Nutzerin das beeinflussen konnte. Jetzt wählbar (global pro Subscription,
-- nicht pro Event — bewusste Vereinfachung): eine Menge von Vorlaufzeiten
-- (z.B. "1 Monat vorher" UND "1 Tag vorher"), die für jedes favorisierte
-- Event gleichermaßen gelten. "Folge ich einem Künstler"-Benachrichtigungen
-- (push_filters/organizers) bleiben unverändert sofort/beim nächsten
-- 15-Minuten-Lauf, da genau das schon dem gewünschten "sofort informiert
-- werden"-Verhalten entspricht.

create table if not exists push_reminder_settings (
  subscription_id uuid primary key references push_subscriptions(id) on delete cascade,
  -- Vorlaufzeiten in Minuten vor Event-Start, z.B. {180} = 3h vorher (Standard,
  -- entspricht dem bisherigen fest codierten Verhalten für alle, die die
  -- Einstellung nie anfassen).
  offsets_minutes integer[] not null default '{180}'
);

alter table push_reminder_settings enable row level security;

drop policy if exists "anon can manage push reminder settings" on push_reminder_settings;
create policy "anon can manage push reminder settings"
  on push_reminder_settings for all
  to anon
  using (true)
  with check (true);

-- notified_at (einzelner Zeitstempel) reicht nicht mehr, sobald pro Favorit
-- mehrere Erinnerungen zu unterschiedlichen Vorlaufzeiten fällig werden
-- können — stattdessen merken, welche der konfigurierten Vorlaufzeiten
-- (in Minuten) für dieses Favorit/Subscription-Paar schon verschickt wurden.
alter table push_favorites drop column if exists notified_at;
alter table push_favorites add column if not exists notified_offsets_minutes integer[] not null default '{}';
