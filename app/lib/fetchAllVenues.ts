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
  if (countError || !count) return [];

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
  return pages.flatMap((p) => (p.data ?? []) as T[]);
}
