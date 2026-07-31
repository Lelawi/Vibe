import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

// Gleiches Cache+Pub/Sub-Muster wie venueFavorites.ts/favorites.ts — Modul-
// level Cache statt Context, damit auch Module außerhalb der React-
// Baumhierarchie (z.B. Hilfsfunktionen) synchron auf die aktuelle Sprache
// zugreifen können, und alle Screens/Komponenten sofort auf einen Wechsel
// reagieren, ohne einen gemeinsamen Provider verdrahten zu müssen.
export type Language = 'de' | 'en';

const STORAGE_KEY = 'vibe:language';
const DEFAULT_LANGUAGE: Language = 'de';

let cache: Language = DEFAULT_LANGUAGE;
let loaded = false;
const listeners = new Set<(lang: Language) => void>();

async function load(): Promise<Language> {
  if (loaded) return cache;
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (raw === 'de' || raw === 'en') cache = raw;
  loaded = true;
  return cache;
}

async function persist(lang: Language) {
  cache = lang;
  await AsyncStorage.setItem(STORAGE_KEY, lang);
  listeners.forEach((l) => l(lang));
}

export function getCurrentLanguage(): Language {
  return cache;
}

export function useLanguage() {
  const [language, setLanguageState] = useState<Language>(cache);

  useEffect(() => {
    let mounted = true;
    load().then((lang) => {
      if (mounted) setLanguageState(lang);
    });
    const listener = (lang: Language) => setLanguageState(lang);
    listeners.add(listener);
    return () => {
      mounted = false;
      listeners.delete(listener);
    };
  }, []);

  return {
    language,
    setLanguage: (lang: Language) => {
      persist(lang);
    },
    toggleLanguage: () => {
      persist(language === 'de' ? 'en' : 'de');
    },
  };
}
