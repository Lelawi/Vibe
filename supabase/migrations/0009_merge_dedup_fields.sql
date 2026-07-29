-- mark_duplicate_events() markierte Dubletten bisher nur, ohne Daten
-- zusammenzuführen: von zwei Quellen für dasselbe Event "gewann" immer die
-- zeitlich zuerst angelegte Zeile, unabhängig davon, welche der beiden Quellen
-- die vollständigeren Daten lieferte. Konkret gingen dadurch systematisch
-- Preise verloren, wenn münchenticket (liefert nie price_info) vor eventim
-- oder muenchenevent lief und als "keep"-Zeile gewann — der echte Preis der
-- als Duplikat verworfenen eventim/muenchenevent-Zeile war damit für die App
-- nicht mehr erreichbar (Audit vom 2026-07-29: 27 von 75 zu dem Zeitpunkt
-- bestehenden Duplikat-Paaren betroffen, meist price_info/description/
-- address/organizer/latitude/longitude).
--
-- Diese Fassung füllt vor dem Markieren fehlende Felder der behaltenen Zeile
-- per COALESCE aus der Dublette auf, statt die zusätzlichen Infos zu
-- verwerfen. Nur nullbare Anreicherungsfelder, keine strukturellen Felder wie
-- title/category/start_date/location_name — die sind bei beiden Zeilen
-- ohnehin vorhanden (sonst hätte der Ähnlichkeitsabgleich nicht gematcht) und
-- sollen nicht quellabhängig überschrieben werden.
--
-- Nutzt eine temporäre Tabelle statt einer einzelnen WITH-verketteten
-- Anweisung: eine WITH-CTE gilt nur für das direkt folgende Statement, nicht
-- für ein zweites danach (erste Fassung dieser Migration scheiterte deshalb
-- zur Laufzeit mit "relation pairs does not exist"). Eine einzelne WITH-Kette
-- aus zwei schreibenden CTEs wäre zwar syntaktisch möglich, riskiert aber
-- "tuple to be updated was already modified"-Laufzeitfehler, sobald eine Zeile
-- innerhalb desselben Laufs sowohl als "keep" (Anreicherung) als auch als
-- "dup" (markiert von einer noch neueren Dublette) auftaucht — bei einer
-- eigenen temporären Tabelle mit zwei sequenziellen UPDATE-Statements tritt
-- dieser Konflikt nicht auf.
create or replace function public.mark_duplicate_events()
returns void
language plpgsql
as $function$
begin
  create temporary table pairs_tmp on commit drop as
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
      and e1.created_at < e2.created_at;

  update events keep
  set
    description = coalesce(keep.description, dup_row.description),
    address = coalesce(keep.address, dup_row.address),
    organizer = coalesce(keep.organizer, dup_row.organizer),
    image_url = coalesce(keep.image_url, dup_row.image_url),
    price_info = coalesce(keep.price_info, dup_row.price_info),
    sold_out = coalesce(keep.sold_out, dup_row.sold_out),
    latitude = coalesce(keep.latitude, dup_row.latitude),
    longitude = coalesce(keep.longitude, dup_row.longitude),
    subcategory = coalesce(keep.subcategory, dup_row.subcategory),
    end_date = coalesce(keep.end_date, dup_row.end_date)
  from pairs_tmp
  join events dup_row on dup_row.id = pairs_tmp.dup_id
  where keep.id = pairs_tmp.keep_id;

  update events
  set duplicate_of = pairs_tmp.keep_id
  from pairs_tmp
  where events.id = pairs_tmp.dup_id;

  drop table pairs_tmp;
end;
$function$;
