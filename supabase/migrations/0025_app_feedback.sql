-- Allgemeiner Feedback-Kanal (Text + optionaler Screenshot), unabhängig von
-- einem konkreten Event/Venue — anders als event_reports (0003) und
-- venue_closure_reports (0012/0013/0015), die beide an eine bestehende Zeile
-- gebunden sind. Kein select für anon: nichts hier muss der Client je wieder
-- zurücklesen, gleiche Begründung wie bei push_subscriptions (0005).
create table if not exists app_feedback (
  id uuid primary key default gen_random_uuid(),
  message text not null,
  screenshot_url text,
  page_context text,
  created_at timestamptz not null default now(),
  status text not null default 'new' check (status in ('new', 'reviewed'))
);
alter table app_feedback enable row level security;

drop policy if exists "anon can submit feedback" on app_feedback;
create policy "anon can submit feedback" on app_feedback
  for insert to anon with check (true);

-- Gleiches enges Muster wie 0020_venue_closure_reports_anon_review.sql:
-- lässt die tägliche Review-Routine (läuft nur mit dem anon key, kein
-- service_role in der Cloud-Umgebung) genau einen Statuswechsel setzen,
-- ohne ihr Lese-/Schreibzugriff auf sonst irgendetwas zu geben.
drop policy if exists "anon can mark own feedback reviewed" on app_feedback;
create policy "anon can mark own feedback reviewed" on app_feedback
  for update to anon using (status = 'new') with check (status = 'reviewed');

-- Public-Read-Bucket, damit die Review-Routine (nur anon key) Screenshots
-- tatsächlich ansehen kann, ohne signierte URLs ausstellen zu müssen. Insert-
-- only für anon, kein Auflisten/Überschreiben fremder Uploads.
insert into storage.buckets (id, name, public)
  values ('feedback-screenshots', 'feedback-screenshots', true)
  on conflict (id) do nothing;

drop policy if exists "anon can upload feedback screenshots" on storage.objects;
create policy "anon can upload feedback screenshots" on storage.objects
  for insert to anon with check (bucket_id = 'feedback-screenshots');
