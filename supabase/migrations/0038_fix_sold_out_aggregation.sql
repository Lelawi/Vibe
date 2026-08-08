-- Bisher: "sold_out = true, wenn keep ODER die aktuell verarbeitete
-- Duplikat-Zeile sold_out=true meldet" — bei 3+ Quellen für dasselbe Event
-- reicht dadurch EINE ausverkaufte Quelle, um das ganze zusammengeführte
-- Event als ausverkauft zu markieren, selbst wenn andere Quellen noch
-- Tickets führen (per Nutzer-Feedback, 2026-08-08: Ticketoptionen sollen
-- pro Quelle einzeln mit Bestpreis markiert werden, nicht gemeinsam als
-- ausverkauft erscheinen, nur weil eine Quelle ausverkauft ist).
--
-- Korrektur: sold_out gilt für das zusammengeführte Event nur dann als true,
-- wenn ALLE Quellen mit bekanntem Status sold_out=true melden (KEINE Quelle
-- mit sold_out=false existiert). Eine einzelne "noch verfügbar"-Quelle
-- gewinnt immer gegen "ausverkauft" anderer Quellen — wer noch ein Ticket
-- bei irgendeiner Quelle kaufen kann, soll das Event nicht als ausverkauft
-- sehen. Läuft als eigener Aggregations-Schritt über jede vollständige
-- Dedup-Gruppe (keep-Zeile + alle ihre Duplikate), nicht mehr paarweise
-- während der bestehenden Merge-Schleife, da die paarweise Reihenfolge
-- sonst vom Zufall abhinge, welche Quelle zuletzt verarbeitet wurde.

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
      e2.id as dup_id,
      public.event_ticket_variant_kind(e2.title) is not null as dup_is_ticket_variant
    from events e1
    join events e2
      on e2.id <> e1.id
      and e2.start_date = e1.start_date
      and e2.city = e1.city
      and (
        e1.start_time = e2.start_time
        or e1.start_time is null
        or e2.start_time is null
        or (
          public.dedup_title_core(e1.title) = public.dedup_title_core(e2.title)
          and (
            public.event_ticket_variant_kind(e1.title) is not null
            or public.event_ticket_variant_kind(e2.title) is not null
          )
        )
      )
      and (
        similarity(lower(e1.title), lower(e2.title)) > 0.4
        or (
          char_length(public.dedup_title_core(e1.title)) >= 3
          and public.dedup_title_core(e1.title) = public.dedup_title_core(e2.title)
        )
        or (
          char_length(public.dedup_title_prefix(e1.title)) >= 4
          and public.dedup_title_prefix(e1.title) = public.dedup_title_prefix(e2.title)
        )
      )
      and e1.location_name is not null
      and e2.location_name is not null
      and similarity(lower(e1.location_name), lower(e2.location_name)) > 0.4
      and (
        case
          when (public.event_ticket_variant_kind(e1.title) is null)
            <> (public.event_ticket_variant_kind(e2.title) is null)
          then public.event_ticket_variant_kind(e1.title) is null
          else row(e1.created_at, e1.id) < row(e2.created_at, e2.id)
        end
      )
    where e1.duplicate_of is null
      and e2.duplicate_of is null
    order by
      e2.id,
      (public.event_ticket_variant_kind(e1.title) is not null) asc,
      e1.created_at asc,
      similarity(lower(e1.title), lower(e2.title)) desc;

  for pair_record in select keep_id, dup_id, dup_is_ticket_variant from pairs_tmp loop
    if not pair_record.dup_is_ticket_variant then
      update events keep
      set
        description = coalesce(keep.description, dup_row.description),
        address = coalesce(keep.address, dup_row.address),
        organizer = coalesce(keep.organizer, dup_row.organizer),
        image_url = coalesce(keep.image_url, dup_row.image_url),
        price_info = coalesce(keep.price_info, dup_row.price_info),
        latitude = coalesce(keep.latitude, dup_row.latitude),
        longitude = coalesce(keep.longitude, dup_row.longitude),
        subcategory = coalesce(keep.subcategory, dup_row.subcategory),
        end_date = coalesce(keep.end_date, dup_row.end_date)
      from events dup_row
      where keep.id = pair_record.keep_id
        and dup_row.id = pair_record.dup_id;
    end if;

    update events
    set duplicate_of = pair_record.keep_id
    where id = pair_record.dup_id;
  end loop;

  drop table pairs_tmp;

  -- sold_out-Aggregation über die komplette (jetzt final zusammengeführte)
  -- Gruppe: "false" (noch verfügbar) schlägt "true" (ausverkauft) schlägt
  -- null (unbekannt) — siehe Migrationskommentar oben.
  update events keep
  set sold_out = grouped.sold_out
  from (
    select
      coalesce(e.duplicate_of, e.id) as group_id,
      case
        when bool_or(e.sold_out is false) then false
        when bool_or(e.sold_out is true) then true
        else null
      end as sold_out
    from events e
    group by 1
  ) grouped
  where keep.id = grouped.group_id
    and keep.duplicate_of is null
    and keep.sold_out is distinct from grouped.sold_out;
end;
$function$;

-- Bestehende Fälle sofort korrigieren, nicht erst beim nächsten Collector-Lauf.
select public.mark_duplicate_events();
