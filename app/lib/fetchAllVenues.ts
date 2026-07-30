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
  const { count, error: countError } = await supabase
    .from('venues')
    .select('id', { count: 'exact', head: true })
    .eq('type', type);
  if (countError) {
    console.error('[fetchAllVenues] count query failed', countError);
    return [];
  }
  if (!count) return [];

  const pageCount = Math.max(1, Math.ceil(count / pageSize));
  const pages = await Promise.all(
    Array.from({ length: pageCount }, (_, i) =>
      supabase
        .from('venues')
        .select(columns)
        .eq('type', type)
        .order('id', { ascending: true })
        .range(i * pageSize, i * pageSize + pageSize - 1)
    )
  );
  // Ein fehlerhaftes Schema (z.B. eine Spalte aus einer noch nicht
  // angewendeten Migration) soll sichtbar auffliegen statt sich als leere
  // Liste zu tarnen — genau das ist beim fehlenden cuisine-Feld passiert
  // ("column venues.cuisine does not exist" führte ohne diesen Check zu
  // einem stillen "keine Bars gefunden", obwohl 581 Bars existierten).
  // Wirft nur, wenn ALLE Seiten fehlschlagen (ein echtes Query-/Schema-
  // Problem) — einzelne fehlgeschlagene Seiten bei riesigen Datenmengen
  // würden sonst schon bei einem einzigen Netzwerk-Hänger die komplette
  // Liste unnötig zum Absturz bringen.
  if (pages.length > 0 && pages.every((p) => p.error)) {
    throw pages[0].error;
  }
  for (const p of pages) {
    if (p.error) console.error('[fetchAllVenues] page query failed', p.error);
  }
  return pages.flatMap((p) => (p.data ?? []) as T[]);
}
