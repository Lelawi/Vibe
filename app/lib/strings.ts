import { useLanguage, getCurrentLanguage, type Language } from './language';

// Flaches Wörterbuch statt verschachtelter Namespace-Objekte — einfacher,
// beim Hinzufügen neuer Strings während der Migration nicht ständig neue
// Objektpfade anlegen zu müssen. Schlüssel sind sprechend und grob nach
// Screen/Bereich präfixiert (z.B. "events.", "venues.", "map."), rein zur
// Lesbarkeit, ohne dass das strukturell erzwungen wird.
export const STRINGS: Record<string, { de: string; en: string }> = {};

// Registriert einen Block zusammengehöriger Strings — pro Screen/Datei
// aufgerufen, damit die Übersetzungen direkt neben dem migrierten Code
// stehen können, statt in einer einzigen, tausende Zeilen langen Datei
// gepflegt werden zu müssen.
export function registerStrings(entries: Record<string, { de: string; en: string }>) {
  Object.assign(STRINGS, entries);
}

// Fällt auf den Key selbst zurück statt zu crashen, wenn eine Übersetzung
// fehlt — im laufenden Betrieb sichtbar (der rohe Key sticht optisch heraus)
// statt eines harten Fehlers, während die App weiterläuft.
export function translate(key: string, lang: Language): string {
  return STRINGS[key]?.[lang] ?? key;
}

// Für Aufrufe außerhalb von React-Komponenten (z.B. in reinen Hilfsfunktionen).
export function t(key: string): string {
  return translate(key, getCurrentLanguage());
}

export function useTranslation() {
  const { language, setLanguage, toggleLanguage } = useLanguage();
  return {
    language,
    setLanguage,
    toggleLanguage,
    t: (key: string) => translate(key, language),
  };
}
