-- (2026-08-08 auf "0035b" umbenannt: zwei unabhängige Migrationen wurden am
-- selben Tag versehentlich beide als "0035" angelegt, siehe 0035a. Beide
-- waren zu diesem Zeitpunkt bereits produktiv angewendet, daher nur
-- Umbenennung zur Klarstellung, keine neue Anwendung nötig.)
--
-- ACHTUNG: die word_similarity-Erweiterung unten wurde durch 0036 wieder
-- zurückgenommen (Fehlverknüpfung verschiedener free&easy-Bands) und die
-- Dedup-Funktion seither mehrfach weiterentwickelt (0038-0040) — dieses File
-- bleibt nur als historischer Zwischenstand stehen, nicht mehr die aktuell
-- gültige Funktionsdefinition.
--
-- Eventim (und mittlerweile auch meinestadt) hängt bei vielen Events einen
-- beschreibenden Untertitel an den Basistitel an, z.B.
--   "Carmen" (deutsches-theater)
--   "Carmen - Tanztheater von Enrique Gasa Valga" (eventim)
--   "Peter und der Wolf" (deutsches-theater)
--   "Peter und der Wolf - eine musikalische Entdeckungsreise" (eventim)
-- Weder die symmetrische similarity() (bestraft den Längenunterschied stark
-- genug, dass sie unter die 0.4-Schwelle fällt) noch dedup_title_core()
-- (kennt nur "Supports:"- und Ticketvarianten-Suffixe, keine allgemeinen
-- Untertitel) erkennen solche Paare — sie blieben bislang unverbunden.
--
-- pg_trgm (bereits aktiv, similarity() nutzt es) bietet zusätzlich
-- word_similarity(a, b): sucht die beste Übereinstimmung von a mit einem
-- zusammenhängenden wortgrenzen-Ausschnitt von b, ohne Längenstrafe für den
-- Rest von b. In beide Richtungen geprüft (mal ist e1, mal e2 der kürzere
-- Titel) und mit demselben konservativen Schwellwert (0.6), den Postgres
-- selbst als Default für den <%-Operator nutzt — bewusst kein niedrigerer
-- Wert, um nicht zwei unterschiedliche Titel mit zufällig ähnlichem Anfang
-- (z.B. zwei verschiedene "Carmen"-Inszenierungen an verschiedenen Tagen/
-- Orten) fälschlich zu verknüpfen. Die Orts- und Datumsbedingungen weiter
-- unten in mark_duplicate_events bleiben unverändert und grenzen zusätzlich ein.

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
        or greatest(
          word_similarity(lower(e1.title), lower(e2.title)),
          word_similarity(lower(e2.title), lower(e1.title))
        ) > 0.6
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

-- Behebt bestehende Dubletten (u.a. Carmen, Peter und der Wolf) direkt beim
-- Anwenden der Migration; der nächste Collector-Lauf nutzt danach
-- automatisch dieselbe verbesserte Funktion.
select public.mark_duplicate_events();
