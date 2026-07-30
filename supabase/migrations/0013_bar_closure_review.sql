-- Ein einzelner Tap auf "Gibt's nicht mehr?" hat die Bar bisher sofort und
-- endgültig aus Liste und Karte verschwinden lassen (siehe 0012) — ein
-- Versehen (z.B. beim Scrollen ausgelöst) war nicht rückgängig zu machen,
-- ohne manuell in Supabase die Zeile zu löschen. Jetzt landet eine Meldung
-- erst im Status "pending": die Bar bleibt sichtbar (mit Hinweis-Badge),
-- bis die Meldung geprüft wurde. Geprüft wird vorerst manuell (siehe
-- collectors/sources/bars/review-closures.ts) statt automatisiert, weil es
-- keine verlässliche freie Datenquelle gibt, die "existiert nicht mehr"
-- automatisch bestätigen könnte.
alter table bar_closure_reports
  add column if not exists status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'rejected'));

-- Bar-Bilder: OSM selbst pflegt so gut wie nie ein "image"-Tag, aber viele
-- Bars haben eine eigene Website mit og:image (analog zu den bestehenden
-- Event-Collectors, z.B. sources/auer_dult, sources/milla).
alter table bars add column if not exists image_url text;
