import { supabase } from './supabase';
import { berlinToday } from './berlinDate';

const PAGE_SIZE = 1000;

// Alle kommenden Events mit Koordinaten für die Karte. Vorher eine einzelne
// Abfrage mit .limit(2000) — Supabase deckelt aber bei 1000 Zeilen, damit
// reichte die Karte nur ~2,5 Wochen weit (1.000 von ~5.400 Events), und ohne
// den end_date-Filter fehlten alle laufenden Ausstellungen/Dulten. Folge:
// der "Wo"-Link auf der Detailseite zeigte für spätere Events keinen Marker.
export async function fetchMapEvents<T>(columns: string): Promise<T[]> {
  const today = berlinToday();
  const upcoming = `start_date.gte.${today},end_date.gte.${today}`;
  const { count, error: countError } = await supabase
    .from('events')
    .select('id', { count: 'exact', head: true })
    .or(upcoming)
    .is('duplicate_of', null)
    .not('latitude', 'is', null)
    .not('longitude', 'is', null);
  if (countError) throw countError;
  if (!count) return [];

  const pages = await Promise.all(
    Array.from({ length: Math.ceil(count / PAGE_SIZE) }, (_, i) =>
      supabase
        .from('events')
        .select(columns)
        .or(upcoming)
        .is('duplicate_of', null)
        .not('latitude', 'is', null)
        .not('longitude', 'is', null)
        .order('start_date', { ascending: true })
        .order('id', { ascending: true })
        .range(i * PAGE_SIZE, i * PAGE_SIZE + PAGE_SIZE - 1)
    )
  );
  const failed = pages.find((p) => p.error);
  if (failed) throw failed.error;
  return pages.flatMap((p) => (p.data ?? []) as T[]);
}
