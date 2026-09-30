import { supabase } from './supabase';
import type { VenueType } from '../components/VenueListScreen';

// Supabase deckelt jede Abfrage hart bei 1000 Zeilen, unabhängig vom
// angeforderten .limit() (per Direktabruf verifiziert, 2026-07 — dieselbe
// Falle wie beim Events-Paginierungs-Bug in index.tsx). Bei aktuell 2263
// Restaurants (Bars: 581) hätte eine einfache .select() über die Hälfte
// aller Restaurants stillschweigend verschluckt. Zählt zuerst, holt dann so
// viele parallele .range()-Seiten wie nötig, mit id als Tiebreaker für eine
// deterministische Seitenreihenfolge.
export async function fetchAllVenues<T>(type: VenueType, columns: string): Promise<T[]> {
  const pageSize = 1000;
  // Bugfund 2026-08-13 (per Nutzer-Meldung "Cafe Bar Omonoia"): diese Query
  // filterte bisher NUR nach `type` — bestaetigt geschlossene Venues wurden
  // nie ausgeblendet, egal ob per Nutzermeldung oder automatisch per Google
  // Places (google_business_status='CLOSED_PERMANENTLY') erkannt. closed_at
  // wird per DB-Trigger synchron zu venue_closure_reports.status gehalten
  // (siehe supabase/migrations/0044_venues_closed_at.sql) — unabhaengig
  // davon, ueber welchen Weg eine Schliessung bestaetigt wurde.
  const { count, error: countError } = await supabase
    .from('venues')
    .select('id', { count: 'exact', head: true })
    .eq('type', type)
    .is('closed_at', null);
  // Werfen statt [] zurückgeben: offline (der Count ist ein HEAD-Request,
  // den der Service Worker nie cacht) überschrieb die leere Liste sonst den
  // gerade angezeigten und den auf Disk gespeicherten Stand mit "Keine Bars
  // gefunden" (Fund 2026-09-30).
  if (countError) throw countError;
  if (!count) return [];

  const pageCount = Math.max(1, Math.ceil(count / pageSize));
  const pages = await Promise.all(
    Array.from({ length: pageCount }, (_, i) =>
      supabase
        .from('venues')
        .select(columns)
        .eq('type', type)
        .is('closed_at', null)
        .order('id', { ascending: true })
        .range(i * pageSize, i * pageSize + pageSize - 1)
    )
  );
  // Ein fehlerhaftes Schema (z.B. eine Spalte aus einer noch nicht
  // angewendeten Migration) soll sichtbar auffliegen statt sich als leere
  // Liste zu tarnen — genau das ist beim fehlenden cuisine-Feld passiert
  // ("column venues.cuisine does not exist" führte ohne diesen Check zu
  // einem stillen "keine Bars gefunden", obwohl 581 Bars existierten).
  // Schlägt auch nur eine Seite fehl, werfen: eine lückenhafte Liste würde
  // sonst als vollständiger Stand angezeigt und auf Disk gecacht. Der
  // Aufrufer behält in dem Fall den bisherigen Stand.
  const failed = pages.find((p) => p.error);
  if (failed) throw failed.error;
  return pages.flatMap((p) => (p.data ?? []) as T[]);
}
