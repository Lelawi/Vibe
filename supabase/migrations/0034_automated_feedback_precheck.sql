-- Sichere Grundlage fuer die automatische Vorpruefung von Freitext und
-- Screenshots. Bilder sind privat; Analyseergebnisse und verwendete Evidenz
-- bleiben pro Meldung nachvollziehbar.

update storage.buckets
set public = false,
    file_size_limit = 5242880,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
where id = 'feedback-screenshots';

drop policy if exists "anon can upload feedback screenshots" on storage.objects;
create policy "anon can upload private feedback screenshots" on storage.objects
  for insert to anon
  with check (
    bucket_id = 'feedback-screenshots'
    and name ~ '^[0-9a-fA-F-]{36}/screenshot\.(jpg|jpeg|png|webp)$'
  );

alter table app_feedback add column if not exists screenshot_path text;
alter table app_feedback add column if not exists screenshot_delete_after timestamptz
  default (now() + interval '30 days');

-- Bestehende oeffentliche URLs in private Objektpfade ueberfuehren.
update app_feedback
set screenshot_path = split_part(screenshot_url, '/feedback-screenshots/', 2)
where screenshot_path is null
  and screenshot_url like '%/feedback-screenshots/%';
update app_feedback set screenshot_url = null where screenshot_path is not null;

do $block$
declare
  table_name text;
begin
  foreach table_name in array array[
    'app_feedback',
    'missing_items',
    'event_reports',
    'venue_reports',
    'venue_closure_reports'
  ] loop
    execute format('alter table %I add column if not exists analysis_status text not null default ''pending''', table_name);
    execute format('alter table %I drop constraint if exists %I', table_name, table_name || '_analysis_status_check');
    execute format(
      'alter table %I add constraint %I check (analysis_status in (''pending'', ''processing'', ''auto_resolved'', ''manual_review'', ''failed'', ''not_applicable''))',
      table_name,
      table_name || '_analysis_status_check'
    );
    execute format('alter table %I add column if not exists analysis_category text', table_name);
    execute format('alter table %I add column if not exists analysis_summary text', table_name);
    execute format('alter table %I add column if not exists analysis_confidence numeric check (analysis_confidence between 0 and 1)', table_name);
    execute format('alter table %I add column if not exists analysis_evidence jsonb not null default ''[]''::jsonb', table_name);
    execute format('alter table %I add column if not exists analyzed_at timestamptz', table_name);
    execute format('alter table %I add column if not exists analysis_error text', table_name);
    execute format('alter table %I add column if not exists analysis_attempts integer not null default 0 check (analysis_attempts between 0 and 3)', table_name);
    execute format('create index if not exists %I on %I(analysis_status) where analysis_status in (''pending'', ''failed'', ''manual_review'')', table_name || '_analysis_open_idx', table_name);
  end loop;
end;
$block$;

-- Bereits entschiedene Altfaelle muessen nicht nachtraeglich analysiert werden.
update app_feedback set analysis_status = 'not_applicable' where status = 'reviewed';
update missing_items set analysis_status = 'not_applicable' where status = 'reviewed';
update event_reports set analysis_status = 'not_applicable' where status <> 'pending';
update venue_reports set analysis_status = 'not_applicable' where status <> 'pending';
update venue_closure_reports set analysis_status = 'not_applicable' where status <> 'pending';

-- Die bisherige Public-Select-Policy wuerde mit den neuen Analysefeldern auch
-- interne Evidenz und Pruefnotizen offenlegen. Die App erhaelt deshalb nur
-- die beiden benoetigten Statusspalten ueber eine schmale View.
drop policy if exists "public read access" on venue_closure_reports;
revoke select on venue_closure_reports from anon, authenticated;
create or replace view public.venue_closure_statuses as
  select venue_id, status from venue_closure_reports;
revoke all on public.venue_closure_statuses from public;
grant select on public.venue_closure_statuses to anon, authenticated;

drop policy if exists "anon can decide a pending closure report" on venue_closure_reports;
drop policy if exists "anon can report a bar as closed" on venue_closure_reports;
revoke insert, update on venue_closure_reports from anon, authenticated;

create or replace function public.submit_venue_closure_report(p_venue_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $function$
begin
  insert into venue_closure_reports (venue_id, status, analysis_status)
  values (p_venue_id, 'pending', 'pending')
  on conflict (venue_id) do update
  set status = 'pending',
      reported_at = now(),
      reviewed_at = null,
      review_note = null,
      analysis_status = 'pending',
      analysis_category = null,
      analysis_summary = null,
      analysis_confidence = null,
      analysis_evidence = '[]'::jsonb,
      analyzed_at = null,
      analysis_error = null,
      analysis_attempts = 0
  where venue_closure_reports.status = 'rejected';
end;
$function$;
revoke all on function public.submit_venue_closure_report(uuid) from public;
grant execute on function public.submit_venue_closure_report(uuid) to anon, authenticated;

-- Anonyme Clients duerfen keine Analyse- oder Entscheidungsfelder vorgeben.
drop policy if exists "anon can submit feedback" on app_feedback;
drop policy if exists "anon can mark own feedback reviewed" on app_feedback;
revoke update on app_feedback from anon, authenticated;
create policy "anon can submit feedback" on app_feedback
  for insert to anon with check (
    status = 'new'
    and analysis_status = 'pending'
    and analysis_category is null
    and analysis_summary is null
    and analysis_confidence is null
    and analysis_evidence = '[]'::jsonb
    and analysis_error is null
    and analysis_attempts = 0
    and reviewed_at is null
    and review_note is null
    and analyzed_at is null
    and screenshot_url is null
    and (screenshot_path is null or screenshot_path = id::text || '/screenshot.jpg')
    and screenshot_delete_after between now() + interval '29 days' and now() + interval '31 days'
  );

drop policy if exists "anyone can report" on event_reports;
create policy "anyone can report" on event_reports
  for insert to anon with check (
    status = 'pending'
    and analysis_status = 'pending'
    and analysis_category is null
    and analysis_summary is null
    and analysis_confidence is null
    and analysis_evidence = '[]'::jsonb
    and analysis_error is null
    and analysis_attempts = 0
    and reviewed_at is null
    and review_note is null
    and analyzed_at is null
  );

drop policy if exists "anyone can report venue data issues" on venue_reports;
create policy "anyone can report venue data issues" on venue_reports
  for insert to anon with check (
    status = 'pending'
    and analysis_status = 'pending'
    and analysis_category is null
    and analysis_summary is null
    and analysis_confidence is null
    and analysis_evidence = '[]'::jsonb
    and analysis_error is null
    and analysis_attempts = 0
    and reviewed_at is null
    and review_note is null
    and analyzed_at is null
  );

drop policy if exists "anon can submit missing items" on missing_items;
create policy "anon can submit missing items" on missing_items
  for insert to anon with check (
    status = 'new'
    and analysis_status = 'pending'
    and analysis_category is null
    and analysis_summary is null
    and analysis_confidence is null
    and analysis_evidence = '[]'::jsonb
    and analysis_error is null
    and analysis_attempts = 0
    and reviewed_at is null
    and review_note is null
    and analyzed_at is null
  );

comment on column app_feedback.screenshot_path is
  'Privater Objektpfad im Bucket feedback-screenshots; niemals eine oeffentliche URL.';
comment on column app_feedback.analysis_evidence is
  'Maschinenlesbare Evidenz der Vorpruefung; KI-Text allein autorisiert keine Datenmutation.';

alter table app_feedback drop constraint if exists app_feedback_message_length_check;
alter table app_feedback add constraint app_feedback_message_length_check
  check (char_length(message) between 1 and 10000);

create or replace function public.schedule_feedback_screenshot_deletion()
returns trigger
language plpgsql
as $function$
begin
  if new.status = 'reviewed' and old.status is distinct from new.status then
    new.screenshot_delete_after := now() + interval '30 days';
  end if;
  return new;
end;
$function$;
revoke all on function public.schedule_feedback_screenshot_deletion() from public;
drop trigger if exists app_feedback_screenshot_retention on app_feedback;
create trigger app_feedback_screenshot_retention before update on app_feedback
  for each row execute function public.schedule_feedback_screenshot_deletion();

create table if not exists automation_audit_log (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  operation text not null,
  report_kind text,
  report_id text,
  outcome text not null,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table automation_audit_log enable row level security;
create index if not exists automation_audit_log_provider_created_idx
  on automation_audit_log(provider, created_at desc);
