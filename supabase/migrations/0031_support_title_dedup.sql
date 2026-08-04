-- Ticketquellen erweitern denselben Haupttitel teils um das komplette
-- Support-Line-up. Beispiel:
--   „Less Than Jake"
--   „Less Than Jake - Supports: A Wilhelm Scream, The Suicide Machines"
-- Die bisherige reine Trigram-Schwelle erkennt solche unterschiedlich langen
-- Titel nicht zuverlässig. Nur explizite Support-/Guest-Marker werden deshalb
-- abgeschnitten; allgemeine Untertitel bleiben unangetastet.

create or replace function public.dedup_title_core(value text)
returns text
language sql
immutable
parallel safe
as $function$
  select trim(
    regexp_replace(
      regexp_replace(
        lower(coalesce(value, '')),
        '[[:space:]]*[-–—|][[:space:]]*(supports?|support acts?|special guests?|guests?)[[:space:]]*:?.*$',
        '',
        'i'
      ),
      '[^[:alnum:]äöüß]+',
      ' ',
      'g'
    )
  );
$function$;

create or replace function public.mark_duplicate_events()
returns void
language plpgsql
as $function$
declare
  pair_record record;
begin
  create temporary table pairs_tmp on commit drop as
    select distinct on (e2.id)
      e1.id as keep_id,
      e2.id as dup_id
    from events e1
    join events e2
      on e2.id <> e1.id
      and e2.start_date = e1.start_date
      and e2.city = e1.city
      -- Gleiche bekannte Uhrzeit oder mindestens eine Quelle ohne Uhrzeit.
      -- Zwei abweichende konkrete Uhrzeiten sind getrennte Vorstellungen.
      and (e1.start_time = e2.start_time or e1.start_time is null or e2.start_time is null)
      and (
        similarity(lower(e1.title), lower(e2.title)) > 0.4
        or (
          char_length(public.dedup_title_core(e1.title)) >= 3
          and public.dedup_title_core(e1.title) = public.dedup_title_core(e2.title)
        )
      )
      and e1.location_name is not null
      and e2.location_name is not null
      and similarity(lower(e1.location_name), lower(e2.location_name)) > 0.4
    where e1.duplicate_of is null
      and e2.duplicate_of is null
      and e1.created_at < e2.created_at
    -- Bei drei oder mehr Quellen zeigt jede jüngere Zeile direkt auf die
    -- älteste behaltene Zeile; dadurch entstehen keine Duplikat-Ketten.
    order by e2.id, e1.created_at asc, similarity(lower(e1.title), lower(e2.title)) desc;

  -- Sequenziell statt UPDATE ... FROM: mehrere Dubletten derselben Keep-Zeile
  -- reichern so tatsächlich alle noch fehlenden Felder an.
  for pair_record in select keep_id, dup_id from pairs_tmp loop
    update events keep
    set
      description = coalesce(keep.description, dup_row.description),
      address = coalesce(keep.address, dup_row.address),
      organizer = coalesce(keep.organizer, dup_row.organizer),
      image_url = coalesce(keep.image_url, dup_row.image_url),
      price_info = coalesce(keep.price_info, dup_row.price_info),
      sold_out = case
        when keep.sold_out is true or dup_row.sold_out is true then true
        else coalesce(keep.sold_out, dup_row.sold_out)
      end,
      latitude = coalesce(keep.latitude, dup_row.latitude),
      longitude = coalesce(keep.longitude, dup_row.longitude),
      subcategory = coalesce(keep.subcategory, dup_row.subcategory),
      end_date = coalesce(keep.end_date, dup_row.end_date)
    from events dup_row
    where keep.id = pair_record.keep_id
      and dup_row.id = pair_record.dup_id;

    update events
    set duplicate_of = pair_record.keep_id
    where id = pair_record.dup_id;
  end loop;

  drop table pairs_tmp;
end;
$function$;

-- Behebt bestehende Dubletten direkt beim Anwenden der Migration; der nächste
-- Collector-Lauf nutzt danach automatisch dieselbe verbesserte Funktion.
select public.mark_duplicate_events();
