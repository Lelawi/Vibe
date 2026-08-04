import { canonicalizeVenue } from './venue';

// Vereinfacht einen Event-Titel für den Vergleich (Groß/Kleinschreibung,
// Satzzeichen, Klammerzusätze wie "(ausverkauft)" spielen keine Rolle).
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    // Ticketanbieter hängen Line-ups oft an den eigentlichen Haupttitel an,
    // z.B. „Less Than Jake – Supports: …“. Für Gruppierung/Deduplizierung ist
    // das weiterhin dasselbe Event; ein beliebiger Untertitel ohne dieses
    // eindeutige Markerwort wird dagegen nicht abgeschnitten.
    .replace(/\s*[-–—|]\s*(?:supports?|support acts?|special guests?|guests?)\s*:?.*$/i, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Gruppiert wiederkehrende Events (gleicher Titel + gleicher Ort) zu einer
// Serie, z.B. wenn "Turntabletennis" jede Woche im selben Club läuft.
export function computeSeriesKey(title: string, locationName: string | null): string {
  return `${normalizeTitle(title)}::${canonicalizeVenue(locationName)}`;
}
