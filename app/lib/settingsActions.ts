// Winziger Pub-Sub, damit app/settings.tsx Aktionen auslösen kann, deren
// eigentliche Implementierung (Event-Neuladen, Erinnerungs-/Gespeicherte-
// Suchen-Modals) weiterhin in app/index.tsx liegt — die Modals sind dort
// recht umfangreich (Kalender, Formulare) und eine 1:1-Duplizierung in
// settings.tsx hätte nur Wartungsrisiko ohne echten Nutzen gebracht. index.tsx
// bleibt beim Navigieren zu /settings im Hintergrund gemountet (Expo-Router-
// Stack-Standardverhalten), der Listener ist also zuverlässig registriert.
type SettingsAction = 'refresh' | 'open-reminder' | 'open-saved-searches';

const listeners = new Set<(action: SettingsAction) => void>();

export function onSettingsAction(listener: (action: SettingsAction) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function requestSettingsAction(action: SettingsAction) {
  listeners.forEach((l) => l(action));
}
