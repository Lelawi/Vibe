-- Viele Theater-/Kultur-Quellen liefern sehr unterschiedliche Vollständigkeit
-- pro Termin derselben Produktion: eventim listet z.B. jeden einzelnen
-- Vorstellungsabend eines langen Theaterlaufs ("Der Brandner Kaspar 3": 30
-- separate Termine) OHNE jedes Mal ein Bild in seiner API zu liefern, während
-- der venue-eigene Scraper (z.B. komoedie_bayerischer_hof, basierend auf
-- in-muenchen.de-Teasern) nur EINEN repräsentativen Termin pro Produktion
-- erfasst, dafür aber mit echtem Bild. Der bestehende Dublikat-Abgleich
-- (mark_duplicate_events) hilft hier nicht — das sind keine Duplikate,
-- sondern echte, unterschiedliche Kalendertermine derselben Inszenierung.
--
-- eventim.de selbst ist für automatisierten Zugriff nicht erreichbar (WAF-
-- Block auch auf der normalen Website, nicht nur der API — per Direktabruf
-- verifiziert, 2026-08-09), ein direkter og:image-Nachschlag wie beim
-- muenchen_stadtportal-Fix ist dort also nicht möglich.
--
-- Stattdessen: ein Bild einer Produktion (gleicher Titel + gleicher Ort)
-- gilt inhaltlich für JEDEN Termin derselben Produktion — sicher zu teilen,
-- ohne Events zusammenzuführen oder zu verstecken (anders als ein
-- Duplikat-Merge bleiben alle Zeilen einzeln sichtbar, nur das Bildfeld
-- wird ergänzt).
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
      and duplicate_of is null
    order by title, location_name, created_at asc
  ) source
  where target.image_url is null
    and target.duplicate_of is null
    and target.title = source.title
    and target.location_name = source.location_name;
$function$;

select public.share_images_across_same_production();
