-- "Loi" bei "Muffathalle" und "Loi" bei "Muffatwerk" (gleicher Termin) wurden
-- nicht zusammengeführt: trigram similarity("muffathalle", "muffatwerk") ~
-- 0.31, unter der 0.4-Schwelle in mark_duplicate_events. Das Projekt kennt
-- diese Aliase aber längst — collectors/core/known_venues.ts (KNOWN_VENUES +
-- PATTERN_VENUES) wird bereits fürs Geocoding genutzt (getCanonicalVenue),
-- nur nicht fürs Dedup. 1:1-Portierung derselben kuratierten Liste nach SQL,
-- statt die generische Trigram-Schwelle abzusenken (das hätte am 2026-08-08
-- schon einmal zu falschen Zusammenführungen geführt, siehe 0035/0036) —
-- hier gilt ein Match nur, wenn BEIDE Seiten auf denselben bekannten,
-- verifizierten kanonischen Venue-Namen abbilden, kein unscharfer Vergleich.
-- Bei Änderungen an known_venues.ts auch diese Funktion synchron halten.

create or replace function public.dedup_known_venue(value text)
returns text
language sql
immutable
parallel safe
as $function$
  select case lower(trim(coalesce(value, '')))
    when 'muffathalle' then 'Muffathalle München'
    when 'muffatwerk' then 'Muffathalle München'
    when 'muffat werk' then 'Muffathalle München'
    when 'zenith münchen' then 'Zenith München'
    when 'zenithhalle' then 'Zenith München'
    when 'zenith munich' then 'Zenith München'
    when 'backstage halle' then 'Backstage München'
    when 'backstage club' then 'Backstage München'
    when 'backstage' then 'Backstage München'
    when 'backstage arena' then 'Backstage München'
    when 'backstage werke' then 'Backstage München'
    when 'backstage arena süd' then 'Backstage München'
    when 'backstage arena süd open air' then 'Backstage München'
    when 'backstage biergarten' then 'Backstage München'
    when 'backstage all area' then 'Backstage München'
    when 'backyard open air' then 'Backstage München'
    when 'gasteig' then 'Gasteig München'
    when 'kulturzentrum gasteig' then 'Gasteig München'
    when 'münchner kammerspiele' then 'Münchner Kammerspiele'
    when 'kammerspiele' then 'Münchner Kammerspiele'
    when 'pasinger fabrik' then 'Pasinger Fabrik'
    when 'pasing fabrik' then 'Pasinger Fabrik'
    when 'glyptothek' then 'Glyptothek München'
    when 'freie theater' then 'Freies Theater München'
    when 'forum am deutschen theater' then 'Forum am Deutschen Theater'
    when 'schlachthof' then 'Gasteig HP8 / Schlachthof'
    when 'gasteig hp8' then 'Gasteig HP8 / Schlachthof'
    when 'kultfabrik' then 'Kultfabrik/Optimolwerke'
    when 'optimolwerke' then 'Kultfabrik/Optimolwerke'
    when 'milla club' then 'Milla Club'
    when 'milla münchen' then 'Milla Club'
    when 'technikum' then 'Technikum München'
    when 'tonhalle' then 'TonHalle München'
    when 'glockenbachwerkstatt' then 'Glockenbachwerkstatt'
    when 'halle 2' then 'Halle 2'
    when 'freie universitÄt' then 'Freie Universität (München)'
    when 'kreativquartier' then 'Kreativquartier München'
    when 'haus der kunst' then 'Haus der Kunst'
    when 'alte kongresshalle' then 'Alte Kongresshalle'
    when 'stadtmuseum' then 'Stadtmuseum München'
    when 'ampere' then 'AMPERE München'
    when 'kubiz' then 'Kubiz München'
    when 'kongress am park' then 'Kongress am Park'
    when 'kulturbahnhof' then 'Kulturbahnhof'
    when 'p1 club' then 'P1'
    when 'import export' then 'Import Export München'
    when 'import/export' then 'Import Export München'
    when 'olympi export' then 'Import Export München'
    when 'impex' then 'Import Export München'
    when 'olympiapark münchen' then 'Olympiapark München'
    when 'olympia park' then 'Olympiapark München'
    when 'brunnenhof' then 'Brunnenhof'
    when 'deutsches theater silbersaal' then 'Deutsches Theater München'
    when 'deutsches theater theatersaal' then 'Deutsches Theater München'
    when 'hotel bayerischer hof, festsaal' then 'Hotel Bayerischer Hof'
    when 'hotel bayerischer hof, night' then 'Hotel Bayerischer Hof'
    when 'residenz, brunnenhof' then 'Brunnenhof'
    when 'residenz, brunnenhof/herkulessaal' then 'Brunnenhof'
    when 'brunnenhof der residenz' then 'Brunnenhof'
    when 'schloss blutenburg, jella' then 'Schloss Blutenburg'
    when 'schloss blutenburg, unterer schlosshof' then 'Schloss Blutenburg'
    when 'schloss blutenburg' then 'Schloss Blutenburg'
    else (
      -- PATTERN_VENUES aus known_venues.ts: unscharfe Erkennung, aber nur
      -- für diese bewusst weit gefassten, bereits verifizierten Muster.
      case
        when value ~* '\mbackstage\M|backyard' then 'Backstage München'
        when value ~* 'muffat' then 'Muffathalle München'
        when value ~* 'zenith' then 'Zenith München'
        when value ~* 'milla' then 'Milla Club'
        when value ~* '\mp\s*1\M' then 'P1'
        when value ~* 'olympia\s*park|olympiapark' then 'Olympiapark München'
        when value ~* 'brunnenhof' then 'Brunnenhof'
        when value ~* 'ampere' then 'AMPERE München'
        when value ~* 'gasteig' then 'Gasteig München'
        when value ~* 'kammerspiele' then 'Münchner Kammerspiele'
        when value ~* 'pasinger fabr' then 'Pasinger Fabrik'
        else null
      end
    )
  end;
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
      and (
        similarity(lower(e1.location_name), lower(e2.location_name)) > 0.4
        or (
          public.dedup_known_venue(e1.location_name) is not null
          and public.dedup_known_venue(e1.location_name) = public.dedup_known_venue(e2.location_name)
        )
      )
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

select public.mark_duplicate_events();
