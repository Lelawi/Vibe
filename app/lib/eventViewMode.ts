import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

// Kompakt (Zeile mit kleinem Thumbnail) vs. Bildkarten (große Fotos,
// gleiches Muster wie der bestehende "cards"-Modus bei Bars/Restaurants/
// Spätis, siehe VenueListScreen.tsx) — dort nur ein lokaler, nicht
// gespeicherter useState pro Screen-Aufruf; für die Eventliste bewusst
// persistiert und über die Einstellungen steuerbar (per Nutzer-Feedback).
// Gleiches lokal-first Muster wie favorites.ts/language.ts.
export type EventViewMode = 'compact' | 'cards';
const STORAGE_KEY = 'vibe:event_view_mode';

let cache: EventViewMode | null = null;
const listeners = new Set<(value: EventViewMode) => void>();

async function load(): Promise<EventViewMode> {
  if (cache !== null) return cache;
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  cache = raw === 'cards' ? 'cards' : 'compact';
  return cache;
}

async function persist(value: EventViewMode) {
  cache = value;
  await AsyncStorage.setItem(STORAGE_KEY, value);
  listeners.forEach((l) => l(value));
}

export function useEventViewMode() {
  const [viewMode, setViewModeState] = useState<EventViewMode>(cache ?? 'compact');

  useEffect(() => {
    let mounted = true;
    load().then((v) => {
      if (mounted) setViewModeState(v);
    });
    const listener = (v: EventViewMode) => setViewModeState(v);
    listeners.add(listener);
    return () => {
      mounted = false;
      listeners.delete(listener);
    };
  }, []);

  return {
    viewMode,
    setViewMode: (v: EventViewMode) => persist(v),
  };
}
