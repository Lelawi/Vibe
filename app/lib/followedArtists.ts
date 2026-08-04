import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

export type FollowedArtist = { id: string; name: string };
const STORAGE_KEY = 'vibe:followed-artists';
let cache: FollowedArtist[] | null = null;
const listeners = new Set<(artists: FollowedArtist[]) => void>();

async function load(): Promise<FollowedArtist[]> {
  if (cache) return cache;
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  cache = raw ? JSON.parse(raw) : [];
  return cache!;
}

async function persist(artists: FollowedArtist[]) {
  cache = artists;
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(artists));
  listeners.forEach((listener) => listener(artists));
}

export function useFollowedArtists() {
  const [followedArtists, setFollowedArtists] = useState<FollowedArtist[]>(cache ?? []);
  useEffect(() => {
    let mounted = true;
    load().then((artists) => { if (mounted) setFollowedArtists(artists); });
    const listener = (artists: FollowedArtist[]) => setFollowedArtists(artists);
    listeners.add(listener);
    return () => { mounted = false; listeners.delete(listener); };
  }, []);

  const isFollowingArtist = (id: string) => followedArtists.some((artist) => artist.id === id);
  const toggleArtist = async (artist: FollowedArtist) => {
    const current = await load();
    await persist(current.some((item) => item.id === artist.id)
      ? current.filter((item) => item.id !== artist.id)
      : [...current, artist]);
  };
  return { followedArtists, isFollowingArtist, toggleArtist };
}
