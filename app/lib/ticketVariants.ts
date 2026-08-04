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
