import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

// Gleiches Cache+Pub/Sub-Muster wie language.ts/favorites.ts — Modul-level
// Cache statt Context, damit app/_layout.tsx (gate) und app/index.tsx
// (Anwenden der Auswahl) unabhängig voneinander denselben Stand sehen, ohne
// einen gemeinsamen Provider verdrahten zu müssen.
type OnboardingState = {
  completed: boolean;
  categories: string[];
  nearby: boolean;
};

const STORAGE_KEY = 'vibe:onboarding';
const DEFAULT_STATE: OnboardingState = { completed: false, categories: [], nearby: false };

let cache: OnboardingState = DEFAULT_STATE;
let loaded = false;
// Verhindert, dass index.tsx die Auswahl bei jedem Mount erneut anwendet
// (z.B. nach Tab-Wechsel zurück zu Events) — einmal konsumiert, bleiben
// spätere manuelle Filteränderungen unangetastet.
let seedConsumed = false;
const listeners = new Set<(state: OnboardingState) => void>();

async function load(): Promise<OnboardingState> {
  if (loaded) return cache;
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        cache = {
          completed: Boolean(parsed.completed),
          categories: Array.isArray(parsed.categories) ? parsed.categories : [],
          nearby: Boolean(parsed.nearby),
        };
      }
    } catch {
      // Kaputtes/altes Format -> Default, kein Crash.
    }
  }
  loaded = true;
  return cache;
}

async function persist(state: OnboardingState) {
  cache = state;
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  listeners.forEach((l) => l(state));
}

export function useOnboarding() {
  const [state, setState] = useState<OnboardingState | null>(loaded ? cache : null);

  useEffect(() => {
    let mounted = true;
    load().then((s) => {
      if (mounted) setState(s);
    });
    const listener = (s: OnboardingState) => setState(s);
    listeners.add(listener);
    return () => {
      mounted = false;
      listeners.delete(listener);
    };
  }, []);

  return {
    loading: state === null,
    completed: state?.completed ?? false,
    complete: (categories: string[], nearby: boolean) => {
      persist({ completed: true, categories, nearby });
    },
  };
}

// Einmaliger Abruf außerhalb von React (index.tsx ruft das in einem
// useEffect beim Mount auf) — liefert die Auswahl nur beim ersten Aufruf
// nach Abschluss des Onboardings, danach immer null.
export async function consumeOnboardingSeed(): Promise<{ categories: string[]; nearby: boolean } | null> {
  if (seedConsumed) return null;
  const s = await load();
  seedConsumed = true;
  if (!s.completed || (s.categories.length === 0 && !s.nearby)) return null;
  return { categories: s.categories, nearby: s.nearby };
}
