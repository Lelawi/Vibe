export type TicketVariantKind = 'premium' | 'flex';

const PREMIUM_SUFFIX = /\s*[-–—|]\s*(?:premium[-\s]?tickets?|vip[-\s]?tickets?|vip\s*&\s*extras?)\s*$/i;
const FLEX_SUFFIX = /\s*[-–—|]\s*flexticket(?:\s+[\p{L}\p{N}]+)*\s*$/iu;
const PREMIUM_URL = /(?:^|[-_/])(?:premium(?:[-_]?tickets?)?|vip(?:[-_]?tickets?)?)(?:[-_/]|$)/i;
const FLEX_URL = /(?:^|[-_/])flexticket(?:[-_/]|$)/i;

export function ticketVariantKind(title: string, sourceUrl?: string | null): TicketVariantKind | null {
  if (PREMIUM_SUFFIX.test(title)) return 'premium';
  if (FLEX_SUFFIX.test(title)) return 'flex';
  // Ältere Eventim-Datensätze enthalten bereits den bereinigten Basistitel.
  // Der Produktlink bewahrt dort weiterhin die Ticketart.
  if (sourceUrl && PREMIUM_URL.test(sourceUrl)) return 'premium';
  if (sourceUrl && FLEX_URL.test(sourceUrl)) return 'flex';
  return null;
}

export function ticketBaseTitle(title: string): string {
  return title
    .replace(PREMIUM_SUFFIX, '')
    .replace(FLEX_SUFFIX, '')
    .toLowerCase()
    // Manche Quellen schreiben "ß" konsequent als "ss" (z.B. reines ASCII-
    // Feed statt echtem ß) — ohne diese Normalisierung erschienen "Weiße
    // Turnschuhe" und "Weisse Turnschuhe" (dieselbe Aufführung, andere
    // Quelle) fälschlich als zwei getrennte Karten statt als eine
    // Terminserie (per Nutzer-Screenshot, 2026-08-08). "ß" ist unicode-
    // technisch ein Buchstabe (\p{L}) und würde sonst unverändert durch den
    // folgenden Satzzeichen-Filter durchrutschen.
    .replace(/ß/g, 'ss')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function ticketVariantLabel(title: string, sourceUrl?: string | null): string {
  const kind = ticketVariantKind(title, sourceUrl);
  if (kind === 'premium') return 'Premium-Ticket';
  if (kind === 'flex') {
    const suffix = title.match(/flexticket(?:\s+[\p{L}\p{N}]+)*/iu)?.[0];
    return suffix ?? 'Flexticket';
  }
  return 'Standard-Ticket';
}

// Extrahiert einen vergleichbaren Preis in Euro aus den unterschiedlichen
// price_info-Formaten der Collectoren ("46.5 EUR" mit Punkt, "49,70 €" mit
// Komma, "ab 12 EUR", "Kostenlos"/"kostenlos" ohne Zahl). Genutzt für die
// Bestpreis-Sortierung über mehrere Quellen hinweg — siehe [id].tsx.
export function parsePriceEur(priceInfo: string | null | undefined): number | null {
  if (!priceInfo) return null;
  if (/kostenlos|free|gratis/i.test(priceInfo)) return 0;
  const match = priceInfo.match(/(\d+(?:[.,]\d{1,2})?)/);
  if (!match) return null;
  const normalized = match[1].replace(',', '.');
  const value = parseFloat(normalized);
  return isNaN(value) ? null : value;
}

// Vereinheitlicht die Preis-Darstellung unabhängig vom Quellformat ("23.9
// EUR" mit Punkt, "ab 23,90 €" mit Komma+Symbol, "0 EUR") — Collector
// schreiben price_info bewusst nicht alle im selben Format (unterschiedliche
// Quell-Frameworks), das sollte aber in der App konsistent aussehen (per
// Nutzer-Feedback, 2026-08-08). "Kostenlos" und ein "ab "-Präfix (mehrere
// Preisstufen) bleiben erhalten, der reine Zahlenteil wird immer als
// deutsches "X,XX €" dargestellt.
export function formatPriceDisplay(priceInfo: string | null | undefined): string | null {
  if (!priceInfo) return null;
  if (/kostenlos|free|gratis/i.test(priceInfo)) return 'Kostenlos';
  const value = parsePriceEur(priceInfo);
  if (value === null) return priceInfo;
  const formatted = value.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const isRange = /^\s*ab\b/i.test(priceInfo);
  return `${isRange ? 'ab ' : ''}${formatted} €`;
}

// Kurzer, für Menschen lesbarer Quellenname aus der Ticket-URL fürs
// Preisvergleich-Listing (z.B. "eventim.de" statt der vollen URL), wenn kein
// erkannter Ticket-Typ (Premium/Flex) vorliegt und daher der generische
// "Standard-Ticket"-Fallback zu wenig Information bietet, um zwei Angebote
// unterschiedlicher Anbieter auseinanderzuhalten.
export function sourceLabelFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}
