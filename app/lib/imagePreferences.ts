import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

// Ob die "✨ Empfohlen für dich"-Bilderkarussell-Zeile ganz oben in der
// Eventliste angezeigt wird (app/index.tsx) — z.B. für eine kompaktere,
// textlastigere Liste oder um Datenverbrauch durch die Vorschaubilder zu
// sparen. Gleiches lokal-first Muster wie favorites.ts/language.ts.
const STORAGE_KEY = 'vibe:show_featured_carousel';

let cache: boolean | null = null;
const listeners = new Set<(value: boolean) => void>();

async function load(): Promise<boolean> {
  if (cache !== null) return cache;
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  // Default an: bestehendes Verhalten bleibt für alle, die den Schalter nie
  // anfassen, unverändert.
  cache = raw === null ? true : raw === '1';
  return cache;
}

async function persist(value: boolean) {
  cache = value;
  await AsyncStorage.setItem(STORAGE_KEY, value ? '1' : '0');
  listeners.forEach((l) => l(value));
}

export function useShowFeaturedCarousel() {
  const [value, setValue] = useState(cache ?? true);

  useEffect(() => {
    let mounted = true;
    load().then((v) => {
      if (mounted) setValue(v);
    });
    const listener = (v: boolean) => setValue(v);
    listeners.add(listener);
    return () => {
      mounted = false;
      listeners.delete(listener);
    };
  }, []);

  return {
    showFeaturedCarousel: value,
    setShowFeaturedCarousel: (v: boolean) => persist(v),
  };
}
