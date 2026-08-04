-- Einheitliche, persistente manuelle Review-Queue. Automatische Checks dürfen
-- Evidenz sammeln, aber ungeklärte Nutzerhinweise nicht selbst verwerfen oder
-- Änderungen durchführen. Jeder Eintrag bleibt offen, bis der Nutzer eine
-- Entscheidung trifft.

alter table event_reports
  add column if not exists status text not null default 'pending';
alter table event_reports drop constraint if exists event_reports_status_check;
alter table event_reports add constraint event_reports_status_check
  check (status in ('pending', 'resolved', 'rejected'));
alter table event_reports add column if not exists reviewed_at timestamptz;
alter table event_reports add column if not exists review_note text;

alter table venue_reports
  add column if not exists status text not null default 'pending';
alter table venue_reports drop constraint if exists venue_reports_status_check;
alter table venue_reports add constraint venue_reports_status_check
  check (status in ('pending', 'resolved', 'rejected'));
alter table venue_reports add column if not exists reviewed_at timestamptz;
alter table venue_reports add column if not exists review_note text;

alter table venue_closure_reports add column if not exists reviewed_at timestamptz;
alter table venue_closure_reports add column if not exists review_note text;
alter table app_feedback add column if not exists reviewed_at timestamptz;
alter table app_feedback add column if not exists review_note text;
alter table missing_items add column if not exists reviewed_at timestamptz;
alter table missing_items add column if not exists review_note text;

-- Der alte Zaehler war fuer eine automatische Entscheidung nach drei
-- Google-Nichttreffern gedacht. Solche Wiederholungen sind keine unabhaengige
-- Evidenz und werden deshalb weder weitergezaehlt noch ausgewertet.
update venues set google_not_found_streak = 0 where google_not_found_streak <> 0;
comment on column venues.google_not_found_streak is
  'Legacy-Feld; seit 0033 nicht mehr zur Schliessungsentscheidung verwendet.';

create index if not exists event_reports_pending_idx
  on event_reports(created_at) where status = 'pending';
create index if not exists venue_reports_pending_idx
  on venue_reports(created_at) where status = 'pending';

-- Setzt den Prüfzeitpunkt automatisch bei einer endgültigen Entscheidung.
-- Pending/new bleibt bewusst ohne Zeitstempel und erscheint jede Woche erneut.
create or replace function public.set_manual_review_timestamp()
returns trigger
language plpgsql
as $function$
begin
  if new.status is distinct from old.status then
    if new.status in ('pending', 'new') then
      new.reviewed_at := null;
    else
      new.reviewed_at := coalesce(new.reviewed_at, now());
    end if;
  end if;
  return new;
end;
$function$;

drop trigger if exists event_reports_review_timestamp on event_reports;
create trigger event_reports_review_timestamp before update on event_reports
  for each row execute function public.set_manual_review_timestamp();
drop trigger if exists venue_reports_review_timestamp on venue_reports;
create trigger venue_reports_review_timestamp before update on venue_reports
  for each row execute function public.set_manual_review_timestamp();
drop trigger if exists venue_closure_reports_review_timestamp on venue_closure_reports;
create trigger venue_closure_reports_review_timestamp before update on venue_closure_reports
  for each row execute function public.set_manual_review_timestamp();
drop trigger if exists app_feedback_review_timestamp on app_feedback;
create trigger app_feedback_review_timestamp before update on app_feedback
  for each row execute function public.set_manual_review_timestamp();
drop trigger if exists missing_items_review_timestamp on missing_items;
create trigger missing_items_review_timestamp before update on missing_items
  for each row execute function public.set_manual_review_timestamp();
