-- dedup_known_venue() kannte "fat cat" und "live evil im fat cat" bereits als
-- Alias fuer "FAT CAT München" (siehe 0040), aber nicht das schlichte
-- "Live/Evil" (mit Schraegstrich), wie es muenchenticket.de als
-- location_name fuer denselben Saal liefert -- per Nutzer-Screenshot
-- gefunden (2026-08-12): "Chat Pile" blieb als zwei sichtbare Zeilen stehen
-- (location_name "Live/Evil" vom muenchenticket-Collector, "FAT CAT" vom
-- eigenen fat-cat-Collector), weder Trigram-Aehnlichkeit noch die
-- bisherige Alias-Liste verband sie. Synchron zu der entsprechenden
-- Ergaenzung in collectors/core/known_venues.ts.
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
    when 'live/evil' then 'FAT CAT München'
    when 'live evil' then 'FAT CAT München'
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

select public.mark_duplicate_events();
