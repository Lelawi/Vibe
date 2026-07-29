-- Verschärft mark_duplicate_events() um einen Ortsabgleich. Die bisherige
-- Fassung (nicht in diesem Repo versioniert, per
-- `select pg_get_functiondef('mark_duplicate_events'::regproc)` aus der
-- Produktion geholt) verglich nur start_date + city + Titel-Ähnlichkeit
-- (similarity() > 0.4) — zwei völlig unterschiedliche Events am selben Tag
-- in München mit generischem, ähnlich klingendem Titel (z.B. "Sommerfest",
-- "Flohmarkt", "Yoga im Park" an verschiedenen Orten) hätten so fälschlich
-- als Duplikat markiert und aus der App verschwinden können. Zusätzlich war
-- der Titelvergleich case-sensitiv, wodurch z.B. "Konzert XY" vs.
-- "KONZERT XY" (unterschiedliche Groß-/Kleinschreibung je nach Quelle)
-- fälschlich NICHT als Duplikat erkannt worden wäre.
--
-- Diese Fassung verlangt zusätzlich eine Orts-Ähnlichkeit (gleiche
-- Trigram-similarity()-Logik wie beim Titel, kein exakter String-Vergleich)
-- — venue-Namen werden je nach Quelle unterschiedlich geschrieben
-- ("Backstage Halle" vs. "Backstage - Werkstatt" vs. "Backstage"; siehe
-- app/lib/venue.ts::canonicalizeVenue, wo das clientseitig schon
-- berücksichtigt wird), ein exakter Vergleich hier würde also echte
-- Duplikate mit leicht abweichender Ortsschreibung verpassen.
create or replace function public.mark_duplicate_events()
returns void
language plpgsql
as $function$
begin
  with pairs as (
    select
      e1.id as keep_id,
      e2.id as dup_id
    from events e1
    join events e2
      on e2.id <> e1.id
      and e2.start_date = e1.start_date
      and e2.city = e1.city
      and similarity(lower(e1.title), lower(e2.title)) > 0.4
      and e1.location_name is not null
      and e2.location_name is not null
      and similarity(lower(e1.location_name), lower(e2.location_name)) > 0.4
    where e1.duplicate_of is null
      and e2.duplicate_of is null
      and e1.created_at < e2.created_at
  )
  update events
  set duplicate_of = pairs.keep_id
  from pairs
  where events.id = pairs.dup_id;
end;
$function$;
