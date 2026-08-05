import { canonicalizeVenue } from './venue';
import { ticketBaseTitle } from './ticketVariants';

// München Ticket führt die einzelnen Angebote des städtischen Ferienprogramms
// als eigenständige Produkte. Für Nutzer sind Stadtreisen, Busausflüge und
// Aktionswochen jedoch Varianten derselben Programmreihe. Die Regel bleibt
// bewusst auf dieses klar benannte Schema begrenzt, damit andere Titel mit
// Bindestrichen nicht versehentlich zusammengefasst werden.
const HOLIDAY_TRIP_SERIES = /^(Sommerferien\s+\d{4}\s*[-–—|]\s*Eintägige\s+Erlebnisreisen)\s*[-–—|]\s*((?:Busausflüge|Stadtreisen)\s+\d+|Aktionswochen)\s*$/iu;

export function seriesDisplayTitle(title: string): string {
  return title.match(HOLIDAY_TRIP_SERIES)?.[1]?.trim() ?? title;
}

export function seriesVariantLabel(title: string): string | null {
  return title.match(HOLIDAY_TRIP_SERIES)?.[2]?.trim() ?? null;
}

// Vereinfacht einen Event-Titel für den Vergleich (Groß/Kleinschreibung,
// Satzzeichen, Klammerzusätze wie "(ausverkauft)" spielen keine Rolle).
function normalizeTitle(title: string): string {
  return ticketBaseTitle(seriesDisplayTitle(title)
    .replace(/\(.*?\)/g, ' ')
    // Ticketanbieter hängen Line-ups oft an den eigentlichen Haupttitel an,
    // z.B. „Less Than Jake – Supports: …“. Für Gruppierung/Deduplizierung ist
    // das weiterhin dasselbe Event; ein beliebiger Untertitel ohne dieses
    // eindeutige Markerwort wird dagegen nicht abgeschnitten.
    .replace(/\s*[-–—|]\s*(?:supports?|support acts?|special guests?|guests?)\s*:?.*$/i, ' '));
}

// Gruppiert wiederkehrende Events (gleicher Titel + gleicher Ort) zu einer
// Serie, z.B. wenn "Turntabletennis" jede Woche im selben Club läuft.
export function computeSeriesKey(title: string, locationName: string | null): string {
  return `${normalizeTitle(title)}::${canonicalizeVenue(locationName)}`;
}
