-- Einmaliges Aufräumen nach den Collector-Fixes vom 2026-09-30.
--
-- 1) muenchen-stadtportal: laufende Ausstellungen bekamen jeden Tag eine neue
--    Zeile, weil die source_id das täglich weiterwandernde itemprop-
--    Startdatum enthielt (z.B. "Inside the Suit" 108 Zeilen, 86 sichtbar;
--    insgesamt 2.465 Mehrtages-Zeilen für 237 echte Events). Der Collector
--    bildet die Identität jetzt aus Titel+Ort+ENDdatum
--    (sources/muenchen_stadtportal/index.ts). Hier: pro Event die jüngste
--    Zeile behalten und auf die neue source_id umschlüsseln — der nächste
--    Lauf aktualisiert genau diese Zeile (Favoriten darauf bleiben erhalten),
--    alle übrigen Tageskopien werden gelöscht. Hash wie buildStableSourceId
--    in core/scrape.ts: md5(title || '::' || location_name), erste 16 Hex.
--
-- 2) Phantom-Termine 2027: parseGermanDate & Co. schoben heutige und kürzlich
--    vergangene Termine ohne Jahresangabe ins Folgejahr (Fix:
--    resolveYearlessDate in core/timezone.ts). Kocherlball (18.07.2027, ein
--    Sonntag) ist eine echte Ankündigung und bleibt.

with multiday as (
  select id,
         'muenchen-stadtportal-' || split_part(source_id, '-', 3) || '-'
           || left(md5(title || '::' || coalesce(location_name, '')), 16) || '-'
           || end_date::text as new_id,
         row_number() over (
           partition by 'muenchen-stadtportal-' || split_part(source_id, '-', 3) || '-'
             || left(md5(title || '::' || coalesce(location_name, '')), 16) || '-' || end_date::text
           order by created_at desc, id desc
         ) as rn
  from events
  where source_id like 'muenchen-stadtportal-%'
    and end_date is not null
    and end_date > start_date
)
delete from events e
using multiday m
where e.id = m.id and m.rn > 1;

with multiday as (
  select id,
         'muenchen-stadtportal-' || split_part(source_id, '-', 3) || '-'
           || left(md5(title || '::' || coalesce(location_name, '')), 16) || '-'
           || end_date::text as new_id
  from events
  where source_id like 'muenchen-stadtportal-%'
    and end_date is not null
    and end_date > start_date
)
update events e
set source_id = m.new_id
from multiday m
where e.id = m.id
  and e.source_id <> m.new_id
  and not exists (select 1 from events x where x.source_id = m.new_id);

delete from events
where start_date >= '2027-01-01'
  and created_at < '2026-10-01'
  and (   source_id like 'glockenbachwerkstatt-%'
       or source_id like 'import-export-%'
       or source_id like 'oktoberfest-events-%'
       or source_id like 'auer-dult-%');

-- 3) Falsche Geokodierungen außerhalb des Großraums München (Nominatim suchte
--    ohne Gebietsbegrenzung, z.B. "Leopoldstr. 13" -> Berlin). core/geocode.ts
--    sucht jetzt nur noch dort; die Einträge werden beim nächsten Lauf neu
--    ermittelt, betroffene Events bekommen ihre Koordinaten beim nächsten
--    Upsert zurück.
delete from venue_coordinates
where latitude not between 47.7 and 48.5
   or longitude not between 11.0 and 12.2;

update events
set latitude = null, longitude = null
where latitude not between 47.7 and 48.5
   or longitude not between 11.0 and 12.2;
