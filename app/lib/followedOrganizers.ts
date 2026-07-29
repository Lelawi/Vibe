import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

// Nach dem Vorbild von Bandsintown/DICE: statt nur einzelne Termine zu
// favorisieren, kann man einem Veranstalter/Künstler "folgen" und wird
// benachrichtigt, sobald der nächste Event von ihm auftaucht — nicht nur
// über den einen Termin, den man gerade sieht. Gleiches lokal-first Muster
// wie favorites.ts (kein Login vorhanden, siehe CLAUDE.md).
const STORAGE_KEY = 'vibe:followed_organizers';

let cache: string[] | null = null;
const listeners = new Set<(names: string[]) => void>();

async function load(): Promise<string[]> {
  if (cache) return cache;
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  cache = raw ? JSON.parse(raw) : [];
  return cache!;
}

async function persist(names: string[]) {
  cache = names;
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(names));
  listeners.forEach((l) => l(names));
}

export async function toggleFollowedOrganizerName(name: string): Promise<string[]> {
  const current = await load();
  const next = current.includes(name) ? current.filter((x) => x !== name) : [...current, name];
  await persist(next);
  return next;
}

export function useFollowedOrganizers() {
  const [followedOrganizers, setFollowedOrganizers] = useState<string[]>(cache ?? []);

  useEffect(() => {
    let mounted = true;
    load().then((names) => {
      if (mounted) setFollowedOrganizers(names);
    });
    const listener = (names: string[]) => setFollowedOrganizers(names);
    listeners.add(listener);
    return () => {
      mounted = false;
      listeners.delete(listener);
    };
  }, []);

  return {
    followedOrganizers,
    isFollowing: (name: string) => followedOrganizers.includes(name),
    toggleFollow: (name: string) => {
      toggleFollowedOrganizerName(name);
    },
  };
}
