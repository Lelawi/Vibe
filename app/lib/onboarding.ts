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
  // Durabler Konsum-Status statt einer reinen In-Memory-Sperre (siehe
  // Kommentar an consumeOnboardingSeed unten) — sonst wurde die Onboarding-
  // Auswahl bei jedem ECHTEN Neuladen der Seite (Modul wird frisch
  // instanziiert, jede In-Memory-Sperre startet wieder bei false) erneut als
  // aktiver Filter gesetzt, obwohl categories/nearby längst "konsumiert"
  // waren. Bei einer lange eingefrorenen/vom OS beendeten Home-Bildschirm-
  // PWA passiert das öfter, als man denkt — sah für den Nutzer aus wie
  // "meine Filter von vor Tagen kommen immer wieder" (per Nutzer-Feedback,
  // 2026-08-11), war aber die einmalige Onboarding-Auswahl, nicht ein
  // Hintergrund/Aufwach-Problem.
  seedApplied: boolean;
};

const STORAGE_KEY = 'vibe:onboarding';
const DEFAULT_STATE: OnboardingState = { completed: false, categories: [], nearby: false, seedApplied: false };

let cache: OnboardingState = DEFAULT_STATE;
let loaded = false;
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
          // Fehlt bei alten, vor diesem Fix gespeicherten Stände (undefined
          // -> false) — dadurch wird die Onboarding-Auswahl für bestehende
          // Nutzer einmalig noch ein letztes Mal angewendet, danach dauerhaft
          // nicht mehr. Siehe Kommentar an OnboardingState.seedApplied.
          seedApplied: Boolean(parsed.seedApplied),
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
      persist({ completed: true, categories, nearby, seedApplied: false });
    },
  };
}

// Liefert die Onboarding-Auswahl nur EINMAL PRO GERÄT (index.tsx ruft das in
// einem useEffect beim Mount auf, um sie als Startfilter anzuwenden) — der
// Konsum-Status ist in AsyncStorage persistiert (seedApplied), nicht nur im
// RAM, damit ein echtes Neuladen der Seite die Onboarding-Auswahl nicht
// erneut als aktiven Filter aufdrängt (siehe Kommentar an
// OnboardingState.seedApplied oben).
export async function consumeOnboardingSeed(): Promise<{ categories: string[]; nearby: boolean } | null> {
  const s = await load();
  if (s.seedApplied) return null;
  await persist({ ...s, seedApplied: true });
  if (!s.completed || (s.categories.length === 0 && !s.nearby)) return null;
  return { categories: s.categories, nearby: s.nearby };
}
