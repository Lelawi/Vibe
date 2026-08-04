-- Ticketanbieter legen für dasselbe Erlebnis eigene Produkte an, z.B.
-- Standard-, Premium- und monatliche Flextickets. Diese Varianten sollen im
-- Feed nicht als separate Events erscheinen. Ihre URLs/Preise bleiben in den
-- als Dublette markierten Zeilen erhalten und werden in der Detailansicht als
-- weitere Ticketoptionen geladen.

create or replace function public.event_ticket_variant_kind(value text)
returns text
language sql
immutable
parallel safe
as $function$
  select case
    when coalesce(value, '') ~* '[[:space:]]*[-–—|][[:space:]]*(premium[-[:space:]]?tickets?|vip[-[:space:]]?tickets?)[[:space:]]*$'
      then 'premium'
    when coalesce(value, '') ~* '[[:space:]]*[-–—|][[:space:]]*flexticket([[:space:]]+[[:alnum:]äöüß]+)*[[:space:]]*$'
      then 'flex'
    else null
  end;
$function$;

create or replace function public.dedup_title_core(value text)
returns text
language sql
immutable
parallel safe
as $function$
  select trim(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          lower(coalesce(value, '')),
          '[[:space:]]*[-–—|][[:space:]]*(supports?|support acts?|special guests?|guests?)[[:space:]]*:?.*$',
          '',
          'i'
        ),
        '[[:space:]]*[-–—|][[:space:]]*((premium|vip)[-[:space:]]?tickets?|flexticket([[:space:]]+[[:alnum:]äöüß]+)*)[[:space:]]*$',
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
        -- Ein expliziter Tickettyp darf eine abweichende Einlasszeit tragen;
        -- dafür müssen die bereinigten Haupttitel exakt übereinstimmen.
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
      )
      and e1.location_name is not null
      and e2.location_name is not null
      and similarity(lower(e1.location_name), lower(e2.location_name)) > 0.4
      and (
        case
          -- Bei Standard gegen Ticketvariante gewinnt immer Standard, auch
          -- wenn beide im selben Collector-Batch dieselbe created_at-Zeit
          -- erhalten haben.
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
    -- Eine Ticketvariante ist keine zweite Informationsquelle: Premiumpreis,
    -- Ausverkauft-Status oder der Monatszeitraum eines Flextickets dürfen den
    -- Standarddatensatz nicht überschreiben/anreichern.
    if not pair_record.dup_is_ticket_variant then
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
    end if;

    update events
    set duplicate_of = pair_record.keep_id
    where id = pair_record.dup_id;
  end loop;

  drop table pairs_tmp;
end;
$function$;

select public.mark_duplicate_events();
