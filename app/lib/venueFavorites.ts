import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

// Eigener Storage-Key statt Wiederverwendung von favorites.ts (Events) --
// zwei unabhängige Listen, damit sie sich nie vermischen und getrennt
// weiterentwickelt werden können (z.B. eine "meine Bars"-Übersicht später),
// auch wenn eine ID-Kollision zwischen Event- und Venue-UUIDs praktisch
// ausgeschlossen ist. Gleiches Cache+Pub/Sub-Muster wie favorites.ts.
const STORAGE_KEY = 'vibe:venue-favorites';

let cache: string[] | null = null;
const listeners = new Set<(ids: string[]) => void>();

async function load(): Promise<string[]> {
  if (cache) return cache;
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  try {
    cache = raw ? JSON.parse(raw) : [];
  } catch {
    cache = [];
  }
  return cache!;
}

async function persist(ids: string[]) {
  cache = ids;
  // Erst die UI aktualisieren, dann speichern: scheiterte setItem (z.B.
  // voller Speicher), blieb die Änderung vorher unsichtbar und ging verloren.
  listeners.forEach((l) => l(ids));
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch (err) {
    console.warn('[venueFavorites] Speichern fehlgeschlagen', err);
  }
}

export async function toggleVenueFavoriteId(id: string): Promise<string[]> {
  const current = await load();
  const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
  await persist(next);
  return next;
}

export function useVenueFavorites() {
  const [favorites, setFavorites] = useState<string[]>(cache ?? []);

  useEffect(() => {
    let mounted = true;
    load().then((ids) => {
      if (mounted) setFavorites(ids);
    });
    const listener = (ids: string[]) => setFavorites(ids);
    listeners.add(listener);
    return () => {
      mounted = false;
      listeners.delete(listener);
    };
  }, []);

  return {
    favorites,
    isFavorite: (id: string) => favorites.includes(id),
    toggleFavorite: (id: string) => {
      toggleVenueFavoriteId(id);
    },
  };
}
