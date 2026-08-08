-- Zwei unabhängige Verbesserungen, per collectors/scripts/duplicate-audit.ts
-- (neu, 2026-08-08) und per Nutzer-Screenshots gefunden:
--
-- 1) dedup_known_venue() um mehrfach bestätigte Venue-Aliase erweitert
--    (synchron zu collectors/core/known_venues.ts) — Tonhalle, FAT CAT/
--    Lucky Punch Comedy Club, Schlachthof-Komplex, Residenz/Hofkapelle.
--
-- 2) Gruppenweites Nachfüllen für ALLE bereits bestehenden Duplikat-Gruppen,
--    nicht nur neu erkannte Paare: mark_duplicate_events() reichert Felder
--    bisher nur EINMALIG beim Erst-Merge an (siehe coalesce in der
--    pairs_tmp-Schleife) — taucht eine Duplikat-Zeile SPÄTER mit besseren
--    Daten auf (z.B. ein Preis, der beim ersten Merge noch fehlte, siehe
--    "Apache 207": eventim-Preis kam erst nach dem Merge dazu, die
--    muenchen-de-Keep-Zeile blieb dauerhaft ohne Preis), wird das nie
--    nachgezogen, weil die WHERE-Klausel nur Zeilen mit
--    duplicate_of IS NULL überhaupt betrachtet. Läuft jetzt zusätzlich als
--    eigener Schritt über ALLE Gruppen (analog zur sold_out-Aggregation aus
--    0038), inkl. Bestpreis-Logik (günstigster geparster Preis gewinnt,
--    nicht nur "erster nicht-NULL-Wert") über eine neue
--    dedup_extract_price_eur()-Hilfsfunktion.

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
    when 'tonhalle münchen' then 'TonHalle München'
    when 'tonhalle - eventfabrik' then 'TonHalle München'
    when 'fat cat' then 'FAT CAT München'
    when 'fat cat, kleiner konzertsaal' then 'FAT CAT München'
    when 'live evil im fat cat' then 'FAT CAT München'
    when 'lucky punch comedy club' then 'FAT CAT München'
    when 'schlachthof münchen' then 'Schlachthof München'
    when 'wirtshaus im schlachthof' then 'Schlachthof München'
    when 'wirtshaus im schlachthof, ox' then 'Schlachthof München'
    when 'wirtshaus im schlachthof, saal' then 'Schlachthof München'
    when 'hofkapelle der residenz' then 'Residenz München'
    when 'residenz münchen' then 'Residenz München'
    else (
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

-- Analog zu app/lib/ticketVariants.ts::parsePriceEur, siehe dortigen
-- Kommentar für die Formatvielfalt ("46.5 EUR" mit Punkt, "49,70 €" mit
-- Komma, "ab 12 EUR", "Kostenlos" ohne Zahl).
create or replace function public.dedup_extract_price_eur(value text)
returns numeric
language plpgsql
immutable
parallel safe
as $function$
declare
  match text;
begin
  if value is null then return null; end if;
  if value ~* 'kostenlos|free|gratis' then return 0; end if;
  match := (regexp_match(value, '([0-9]+([.,][0-9]{1,2})?)'))[1];
  if match is null then return null; end if;
  return replace(match, ',', '.')::numeric;
exception when others then
  return null;
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

  -- sold_out-Aggregation über die komplette Gruppe (siehe 0038).
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

  -- Generisches Nachfüllen (description/address/organizer/image_url/
  -- latitude/longitude/subcategory/end_date): erster nicht-NULL-Wert über
  -- die komplette Gruppe, nicht nur die beim Erst-Merge beteiligten zwei
  -- Zeilen — behebt z.B. ein Bild, das erst durch einen SPÄTER
  -- hinzugekommenen Duplikat-Fund verfügbar wurde.
  update events keep
  set
    description = coalesce(keep.description, grouped.description),
    address = coalesce(keep.address, grouped.address),
    organizer = coalesce(keep.organizer, grouped.organizer),
    image_url = coalesce(keep.image_url, grouped.image_url),
    latitude = coalesce(keep.latitude, grouped.latitude),
    longitude = coalesce(keep.longitude, grouped.longitude),
    subcategory = coalesce(keep.subcategory, grouped.subcategory),
    end_date = coalesce(keep.end_date, grouped.end_date)
  from (
    select
      coalesce(e.duplicate_of, e.id) as group_id,
      (array_agg(e.description order by e.created_at) filter (where e.description is not null))[1] as description,
      (array_agg(e.address order by e.created_at) filter (where e.address is not null))[1] as address,
      (array_agg(e.organizer order by e.created_at) filter (where e.organizer is not null))[1] as organizer,
      (array_agg(e.image_url order by e.created_at) filter (where e.image_url is not null))[1] as image_url,
      (array_agg(e.latitude order by e.created_at) filter (where e.latitude is not null))[1] as latitude,
      (array_agg(e.longitude order by e.created_at) filter (where e.longitude is not null))[1] as longitude,
      (array_agg(e.subcategory order by e.created_at) filter (where e.subcategory is not null))[1] as subcategory,
      (array_agg(e.end_date order by e.created_at) filter (where e.end_date is not null))[1] as end_date
    from events e
    group by 1
  ) grouped
  where keep.id = grouped.group_id
    and keep.duplicate_of is null;

  -- Bestpreis-Nachfüllen: günstigster geparster Preis über die komplette
  -- Gruppe gewinnt (nicht nur "erster nicht-NULL-Wert") — z.B. "Apache 207"
  -- (muenchen-de ohne Preis, eventim-Duplikat mit "ab 70,40 €" kam erst nach
  -- dem Erst-Merge dazu und wurde nie nachgezogen).
  update events keep
  set price_info = grouped.price_info
  from (
    select
      coalesce(e.duplicate_of, e.id) as group_id,
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

select public.mark_duplicate_events();
