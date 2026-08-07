-- RÜCKBAU/KORREKTUR von 0035_word_similarity_dedup.sql: der dortige
-- word_similarity()-Ansatz (kürzerer Titel matcht als Block irgendwo im
-- längeren) hat sich als zu riskant erwiesen. Per Direktabfrage verifiziert
-- (2026-08): bei Reihen-/Festival-Titeln wie "ELLES | free & easy 2026 live"
-- vs. "free and easy 2026" matcht der gemeinsame Reihen-Name fast perfekt,
-- während der eigentlich unterscheidende Band-/Act-Name ("ELLES" vs.
-- "VOGELMAYER" vs. "MUNICH MUSIC QUIZ" ...) komplett ignoriert wird — echte,
-- verschiedene Programmpunkte desselben Festivaltags wurden dadurch
-- fälschlich als ein einziges Event zusammengeführt.
--
-- Ersetzt durch einen deutlich engeren Vergleich: dedup_title_prefix()
-- schneidet einen Titel NUR am ersten " - "/" – "/" — " ab (Leerzeichen auf
-- beiden Seiten verlangt, damit Bindestriche in zusammengesetzten
-- Eigennamen wie "D'Filsers-Dau" nicht versehentlich mitten im Wort greifen)
-- und behält den Teil davor. Zwei Titel gelten nur als Kern-Match, wenn
-- dieser abgeschnittene Präfix EXAKT übereinstimmt (nicht nur "kommt
-- irgendwo vor"):
--   "Carmen" vs. "Carmen - Tanztheater von Enrique Gasa Valga"
--     -> beide "carmen" -> Match (korrekt, gleiche Produktion)
--   "free and easy 2026" vs. "ELLES | free & easy 2026 live"
--     -> "free and easy 2026" hat keinen Bindestrich, bleibt komplett;
--        "elles free easy 2026 live" (kein abschneidbarer Bindestrich-Teil,
--        da "|" kein Trennzeichen für diese Funktion ist) -> kein Match
--        (korrekt, unterschiedliche Acts)

create or replace function public.dedup_title_prefix(value text)
returns text
language sql
immutable
parallel safe
as $function$
  select trim(
    regexp_replace(
      regexp_replace(
        lower(coalesce(value, '')),
        '[[:space:]]+[-–—][[:space:]].*$',
        ''
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

-- WICHTIG: alle per 0035 gesetzten duplicate_of-Verknüpfungen vollständig
-- zurücksetzen, bevor mit der korrigierten Funktion neu gruppiert wird —
-- sonst blieben die fälschlich zusammengeführten Events (z.B. die
-- verschiedenen free&easy-Acts) für immer verknüpft, weil
-- mark_duplicate_events nur Zeilen mit duplicate_of IS NULL überhaupt
-- betrachtet. Betroffene Felder (description/image_url/etc.), die durch die
-- falsche Zusammenführung befüllt wurden, heilen sich über die nächsten
-- Collector-Läufe von selbst aus, da jede Quelle ihre eigenen Felder bei
-- jedem Upsert ohnehin komplett neu schreibt.
update events set duplicate_of = null where duplicate_of is not null;

select public.mark_duplicate_events();
