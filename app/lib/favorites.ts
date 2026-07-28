import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

// Kein Login-System vorhanden (App ist rein lesend gegen Supabase, siehe
// CLAUDE.md) — Favoriten leben deshalb nur lokal auf dem Gerät.
const STORAGE_KEY = 'vibe:favorites';

let cache: string[] | null = null;
const listeners = new Set<(ids: string[]) => void>();

async function load(): Promise<string[]> {
  if (cache) return cache;
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  cache = raw ? JSON.parse(raw) : [];
  return cache!;
}

async function persist(ids: string[]) {
  cache = ids;
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  listeners.forEach((l) => l(ids));
}

export async function toggleFavoriteId(id: string): Promise<string[]> {
  const current = await load();
  const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
  await persist(next);
  return next;
}

// Ein Hook statt Context: mehrere Screens (Liste, Detail) sollen sofort
// synchron bleiben, ohne die ganze App in einen Provider zu wickeln — ein
// modulweiter Cache + Pub/Sub reicht für diese Größenordnung an State.
export function useFavorites() {
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
      toggleFavoriteId(id);
    },
  };
}
