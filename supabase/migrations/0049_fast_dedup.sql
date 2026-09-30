-- Fund (2026-09-30, Code-Review): "Collect All Events" schlug seit dem
-- 2026-08-27 täglich im letzten Schritt (npm run dedup) fehl. Ursache:
-- mark_duplicate_events() überschritt das von PostgREST geerbte
-- statement_timeout von 8s (authenticator; service_role hatte keinen
-- eigenen Wert) — gemessen 13,2s für die Paar-Suche. Folge: seit fünf
-- Wochen keine Duplikat-Markierung (~585 sichtbare Duplikate) und kein
-- Bild-Teilen mehr (dedup/index.ts brach vorher ab).
--
-- Warum langsam: dedup_title_core/_prefix, event_ticket_variant_kind und
-- dedup_known_venue (Regex/CASE) wurden in den Join-Filter geinlined und
-- pro Kandidatenpaar neu berechnet (~783k Paare im Nested Loop), und zwar
-- über die komplette Historie inkl. längst vergangener Events.
--
-- Fix (Logik 1:1 wie 0040, nur umstrukturiert):
--   1. Normalisierung einmal pro Zeile in einer MATERIALIZED-CTE
--      (Planer wechselt auf Hash Join über start_date/city): ~1s statt 13s.
--   2. Nur Tage mit kommenden/laufenden Events betrachten (~0,6s). Paare
--      haben immer dasselbe start_date, laufende Mehrtages-Events bleiben
--      über end_date erfasst.
--   3. Gruppenweites Nachfüllen schreibt nur noch Zeilen, die sich
--      tatsächlich ändern (vorher jedes Mal alle ~11.900 Keep-Zeilen).
--   4. Dedup-Updates setzen source_checked_at nicht mehr (Trigger-Flag):
--      vorher zeigte die App "zuletzt geprüft: heute" auch für Quellen, die
--      seit Wochen nichts mehr liefern, weil Dedup täglich alle Zeilen
--      anfasste.
--   5. statement_timeout für service_role auf 60s als Reserve.
--   6. Dedup/Bild-Teilen sind reine Service-Jobs — nicht mehr als RPC für
--      anon/authenticated aufrufbar (teuer, DoS-Fläche).
--   7. FK duplicate_of: ON DELETE SET NULL + Index (Löschen einer
--      Keep-Zeile, z.B. durch theatron, scheiterte sonst an der FK).

alter role service_role set statement_timeout = '60s';
notify pgrst, 'reload config';

create or replace function public.mark_duplicate_events()
returns void
language plpgsql
set search_path = public
as $function$
declare
  pair_record record;
begin
  -- Hinweis für prepare_event_source_update: Dedup-Updates sind keine
  -- Quellen-Prüfung. Gilt nur für diese Transaktion.
  perform set_config('vibe.skip_source_check', 'on', true);

  create temporary table pairs_tmp on commit drop as
  with relevant_dates as (
    select distinct start_date
    from events
    where duplicate_of is null
      and (start_date >= current_date - 1 or end_date >= current_date)
  ),
  base as materialized (
    select e.id, e.start_date, e.start_time, e.city, e.created_at,
           lower(e.title)                            as title_l,
           lower(e.location_name)                    as loc_l,
           public.dedup_title_core(e.title)          as core,
           public.dedup_title_prefix(e.title)        as prefix,
           public.event_ticket_variant_kind(e.title) as variant,
           public.dedup_known_venue(e.location_name) as kv
    from events e
    join relevant_dates d on d.start_date = e.start_date
    where e.duplicate_of is null
      and e.location_name is not null
  )
  select distinct on (e2.id)
    e1.id as keep_id,
    e2.id as dup_id,
    e2.variant is not null as dup_is_ticket_variant
  from base e1
  join base e2
    on e2.id <> e1.id
   and e2.start_date = e1.start_date
   and e2.city = e1.city
   and (
     e1.start_time = e2.start_time
     or e1.start_time is null
     or e2.start_time is null
     or (e1.core = e2.core and (e1.variant is not null or e2.variant is not null))
   )
   and (
     similarity(e1.title_l, e2.title_l) > 0.4
     or (char_length(e1.core) >= 3 and e1.core = e2.core)
     or (char_length(e1.prefix) >= 4 and e1.prefix = e2.prefix)
   )
   and (
     similarity(e1.loc_l, e2.loc_l) > 0.4
     or (e1.kv is not null and e1.kv = e2.kv)
   )
   and (
     case
       when (e1.variant is null) <> (e2.variant is null) then e1.variant is null
       else row(e1.created_at, e1.id) < row(e2.created_at, e2.id)
     end
   )
  order by e2.id,
           (e1.variant is not null) asc,
           e1.created_at asc,
           similarity(e1.title_l, e2.title_l) desc;

  for pair_record in select keep_id, dup_id, dup_is_ticket_variant from pairs_tmp loop
    if not pair_record.dup_is_ticket_variant then
      update events keep
      set description = coalesce(keep.description, dup_row.description),
          address     = coalesce(keep.address, dup_row.address),
          organizer   = coalesce(keep.organizer, dup_row.organizer),
          image_url   = coalesce(keep.image_url, dup_row.image_url),
          price_info  = coalesce(keep.price_info, dup_row.price_info),
          latitude    = coalesce(keep.latitude, dup_row.latitude),
          longitude   = coalesce(keep.longitude, dup_row.longitude),
          subcategory = coalesce(keep.subcategory, dup_row.subcategory),
          end_date    = coalesce(keep.end_date, dup_row.end_date)
      from events dup_row
      where keep.id = pair_record.keep_id
        and dup_row.id = pair_record.dup_id;
    end if;

    update events set duplicate_of = pair_record.keep_id where id = pair_record.dup_id;
  end loop;

  drop table pairs_tmp;

  -- sold_out-Aggregation über die komplette Gruppe (siehe 0038). Einzel-
  -- Gruppen ändern sich nie (Aggregat = eigener Wert), daher having > 1.
  update events keep
  set sold_out = grouped.sold_out
  from (
    select coalesce(e.duplicate_of, e.id) as group_id,
           case when bool_or(e.sold_out is false) then false
                when bool_or(e.sold_out is true)  then true
                else null end as sold_out
    from events e
    group by 1
    having count(*) > 1
  ) grouped
  where keep.id = grouped.group_id
    and keep.duplicate_of is null
    and keep.sold_out is distinct from grouped.sold_out;

  -- Generisches Nachfüllen über die komplette Gruppe (siehe 0040) — nur
  -- Zeilen, bei denen sich wirklich etwas ändert.
  update events keep
  set description = coalesce(keep.description, g.description),
      address     = coalesce(keep.address, g.address),
      organizer   = coalesce(keep.organizer, g.organizer),
      image_url   = coalesce(keep.image_url, g.image_url),
      latitude    = coalesce(keep.latitude, g.latitude),
      longitude   = coalesce(keep.longitude, g.longitude),
      subcategory = coalesce(keep.subcategory, g.subcategory),
      end_date    = coalesce(keep.end_date, g.end_date)
  from (
    select coalesce(e.duplicate_of, e.id) as group_id,
      (array_agg(e.description order by e.created_at) filter (where e.description is not null))[1] as description,
      (array_agg(e.address     order by e.created_at) filter (where e.address     is not null))[1] as address,
      (array_agg(e.organizer   order by e.created_at) filter (where e.organizer   is not null))[1] as organizer,
      (array_agg(e.image_url   order by e.created_at) filter (where e.image_url   is not null))[1] as image_url,
      (array_agg(e.latitude    order by e.created_at) filter (where e.latitude    is not null))[1] as latitude,
      (array_agg(e.longitude   order by e.created_at) filter (where e.longitude   is not null))[1] as longitude,
      (array_agg(e.subcategory order by e.created_at) filter (where e.subcategory is not null))[1] as subcategory,
      (array_agg(e.end_date    order by e.created_at) filter (where e.end_date    is not null))[1] as end_date
    from events e
    group by 1
    having count(*) > 1
  ) g
  where keep.id = g.group_id
    and keep.duplicate_of is null
    and (   (keep.description is null and g.description is not null)
         or (keep.address     is null and g.address     is not null)
         or (keep.organizer   is null and g.organizer   is not null)
         or (keep.image_url   is null and g.image_url   is not null)
         or (keep.latitude    is null and g.latitude    is not null)
         or (keep.longitude   is null and g.longitude   is not null)
         or (keep.subcategory is null and g.subcategory is not null)
         or (keep.end_date    is null and g.end_date    is not null));

  -- Bestpreis-Nachfüllen (siehe 0040).
  update events keep
  set price_info = grouped.price_info
  from (
    select coalesce(e.duplicate_of, e.id) as group_id,
           (array_agg(e.price_info order by public.dedup_extract_price_eur(e.price_info) asc nulls last))[1] as price_info
    from events e
    where e.price_info is not null
    group by 1
  ) grouped
  where keep.id = grouped.group_id
    and keep.duplicate_of is null
    and keep.price_info is null;
end;
$function$;

create or replace function public.prepare_event_source_update()
returns trigger
language plpgsql
set search_path = public
as $function$
begin
  if coalesce(current_setting('vibe.skip_source_check', true), '') <> 'on' then
    new.source_checked_at := now();
  end if;
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
$function$;

revoke execute on function public.mark_duplicate_events() from public, anon, authenticated;
revoke execute on function public.share_images_across_same_production() from public, anon, authenticated;

alter table events drop constraint if exists events_duplicate_of_fkey;
alter table events
  add constraint events_duplicate_of_fkey
  foreign key (duplicate_of) references events(id) on delete set null;
create index if not exists events_duplicate_of_idx on events(duplicate_of) where duplicate_of is not null;
