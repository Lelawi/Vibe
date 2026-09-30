// Winziger Pub-Sub, damit app/settings.tsx Aktionen auslösen kann, deren
// eigentliche Implementierung (Event-Neuladen, Erinnerungs-/Gespeicherte-
// Suchen-Modals) weiterhin in app/index.tsx liegt — die Modals sind dort
// recht umfangreich (Kalender, Formulare) und eine 1:1-Duplizierung in
// settings.tsx hätte nur Wartungsrisiko ohne echten Nutzen gebracht. index.tsx
// bleibt beim Navigieren zu /settings im Hintergrund gemountet (Expo-Router-
// Stack-Standardverhalten) — aber nur, wenn man von dort kam (siehe pending).
type SettingsAction = 'refresh' | 'open-reminder' | 'open-saved-searches';

const listeners = new Set<(action: SettingsAction) => void>();

// Von den Bars/Restaurants/Spätis-Tabs aus ist index.tsx NICHT gemountet
// (Tabs wechseln per router.replace) — die Aktion verpuffte dann ohne
// Empfänger (Fund 2026-09-30). Sie wird deshalb vorgemerkt und beim nächsten
// Registrieren eines Listeners (index.tsx mountet) zugestellt.
let pending: SettingsAction | null = null;

export function onSettingsAction(listener: (action: SettingsAction) => void): () => void {
  listeners.add(listener);
  if (pending) {
    const action = pending;
    pending = null;
    listener(action);
  }
  return () => listeners.delete(listener);
}

// true = sofort zugestellt (Eventliste lebt im Hintergrund), false =
// vorgemerkt; der Aufrufer muss dann zur Eventliste navigieren.
export function requestSettingsAction(action: SettingsAction): boolean {
  if (listeners.size === 0) {
    pending = action;
    return false;
  }
  listeners.forEach((l) => l(action));
  return true;
}
