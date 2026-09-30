import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

// Vorlaufzeiten für Favoriten-Erinnerungen, wählbar statt fix (siehe Migration
// 0010_reminder_offsets.sql) — global pro Gerät, nicht pro Event. Gleiches
// lokal-first Muster wie followedOrganizers.ts.
const STORAGE_KEY = 'vibe:reminder_offsets_minutes';

// Entspricht dem bisherigen fest codierten Verhalten (3h vorher), damit sich
// für niemanden stillschweigend etwas ändert, der die Einstellung nie anfasst.
export const DEFAULT_OFFSETS_MINUTES = [180];

export const REMINDER_OFFSET_OPTIONS: { minutes: number; label: string }[] = [
  { minutes: 43_200, label: '1 Monat vorher' },
  { minutes: 10_080, label: '1 Woche vorher' },
  { minutes: 1_440, label: '1 Tag vorher' },
  { minutes: 180, label: '3 Stunden vorher' },
];

let cache: number[] | null = null;
const listeners = new Set<(offsets: number[]) => void>();

async function load(): Promise<number[]> {
  if (cache) return cache;
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  try {
    cache = raw ? JSON.parse(raw) : DEFAULT_OFFSETS_MINUTES;
  } catch {
    cache = DEFAULT_OFFSETS_MINUTES;
  }
  return cache!;
}

async function persist(offsets: number[]) {
  cache = offsets;
  // Erst die UI aktualisieren, dann speichern: scheiterte setItem (z.B.
  // voller Speicher), blieb die Änderung vorher unsichtbar und ging verloren.
  listeners.forEach((l) => l(offsets));
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(offsets));
  } catch (err) {
    console.warn('[reminderSettings] Speichern fehlgeschlagen', err);
  }
}

export function useReminderSettings() {
  const [offsetsMinutes, setOffsetsMinutes] = useState<number[]>(cache ?? DEFAULT_OFFSETS_MINUTES);

  useEffect(() => {
    let mounted = true;
    load().then((offsets) => {
      if (mounted) setOffsetsMinutes(offsets);
    });
    const listener = (offsets: number[]) => setOffsetsMinutes(offsets);
    listeners.add(listener);
    return () => {
      mounted = false;
      listeners.delete(listener);
    };
  }, []);

  return {
    offsetsMinutes,
    toggleOffset: (minutes: number) => {
      const next = offsetsMinutes.includes(minutes)
        ? offsetsMinutes.filter((m) => m !== minutes)
        : [...offsetsMinutes, minutes];
      persist(next);
    },
  };
}
