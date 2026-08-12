-- Fund (2026-08-13, per Nutzer-Meldung "Cafe Bar Omonoia"): die App hat NIE
-- geschlossene Venues ausgeblendet, egal wie sie als geschlossen erkannt
-- wurden. fetchAllVenues() (app/lib/fetchAllVenues.ts) filtert bisher nur
-- nach `type` -- weder venue_closure_reports.status='confirmed' noch
-- venues.google_business_status='CLOSED_PERMANENTLY' hatten je einen Effekt
-- auf die angezeigte Liste. Konkreter Fall: Omonoia wurde von der
-- google-ratings-Routine korrekt als CLOSED_PERMANENTLY erkannt (Rating 4.2,
-- 62 Bewertungen, google_business_status gesetzt) -- aber nichts hat daraus
-- je eine Konsequenz gezogen, weder eine Schliessungsmeldung noch ein
-- Ausblenden in der App.
--
-- Zusaetzliches Problem beim naheliegenden "einfach venue_closure_reports
-- direkt aus der App abfragen": RLS (0037) erlaubt anon dort NUR Zeilen mit
-- analysis_status='manual_review' zu lesen -- automatisch abgeschlossene
-- ("auto_resolved") Faelle waeren fuer die App unsichtbar, selbst wenn sie
-- confirmed sind. Eine neue RLS-Policy dafuer wuerde Analyse-Interna
-- (analysis_evidence etc.) fuer alle Nutzer offenlegen, nur um ein
-- boolesches "ist geschlossen" zu bekommen.
--
-- Loesung: ein denormalisiertes closed_at direkt auf venues, per Trigger
-- synchron zu venue_closure_reports.status gehalten -- unabhaengig davon,
-- ueber welchen Weg eine Schliessung bestaetigt wird (review-closures.ts,
-- die taeglichen Cloud-Routinen, der interaktive Bericht, manuelle Skripte).
-- venues hat bereits eine oeffentliche Select-Policy, keine neue noetig.
alter table public.venues add column if not exists closed_at timestamptz;

create or replace function public.sync_venue_closed_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
  if new.status = 'confirmed' and old.status is distinct from 'confirmed' then
    update public.venues set closed_at = coalesce(new.reviewed_at, now()) where id = new.venue_id;
  elsif old.status = 'confirmed' and new.status is distinct from 'confirmed' then
    -- Entscheidung wurde korrigiert/zurueckgesetzt (z.B. faelschlich
    -- bestaetigt) -- Venue wieder sichtbar machen statt dauerhaft versteckt
    -- zu lassen.
    update public.venues set closed_at = null where id = new.venue_id;
  end if;
  return new;
end;
$function$;

drop trigger if exists venue_closure_reports_sync_closed_at on venue_closure_reports;
create trigger venue_closure_reports_sync_closed_at
  after update on venue_closure_reports
  for each row
  execute function public.sync_venue_closed_at();

-- Backfill: bereits vor diesem Trigger bestaetigte Schliessungen nachziehen.
update public.venues v
set closed_at = coalesce(vcr.reviewed_at, now())
from public.venue_closure_reports vcr
where vcr.venue_id = v.id and vcr.status = 'confirmed' and v.closed_at is null;
