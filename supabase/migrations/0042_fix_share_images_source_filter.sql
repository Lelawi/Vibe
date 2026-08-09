-- Fix für 0041: die Bild-Quellzeile ist oft selbst ein via
-- mark_duplicate_events() zusammengeführtes Duplikat (duplicate_of gesetzt)
-- -- z.B. lief der komoedie_bayerischer_hof-Termin für "Der Brandner
-- Kaspar 3" (echtes Bild) am selben Datum wie ein eventim-Termin und wurde
-- in diesen gemergt. 0041 verlangte "duplicate_of is null" auch auf der
-- QUELLSEITE und fand dadurch keine gültige Bildquelle mehr (per
-- Live-Verifikation nach Anwenden von 0041, 2026-08-09: 1/31 statt der
-- erwarteten Mehrheit hatte ein Bild). Das Bild einer zusammengeführten
-- Zeile ist inhaltlich weiterhin gültig für dieselbe Produktion -- die
-- duplicate_of-Einschränkung bleibt nur auf der ZIELSEITE (nicht an bereits
-- versteckte/gemergte Zeilen schreiben, unnötig aber unschädlich wäre es
-- auch dort).
create or replace function public.share_images_across_same_production()
returns void
language sql
as $function$
  update events target
  set image_url = source.image_url
  from (
    select distinct on (title, location_name) title, location_name, image_url
    from events
    where image_url is not null
    order by title, location_name, created_at asc
  ) source
  where target.image_url is null
    and target.duplicate_of is null
    and target.title = source.title
    and target.location_name = source.location_name;
$function$;

select public.share_images_across_same_production();
