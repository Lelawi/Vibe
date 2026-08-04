export type TicketVariantKind = 'premium' | 'flex';

const PREMIUM_SUFFIX = /\s*[-–—|]\s*(?:premium[-\s]?tickets?|vip[-\s]?tickets?)\s*$/i;
const FLEX_SUFFIX = /\s*[-–—|]\s*flexticket(?:\s+[\p{L}\p{N}]+)*\s*$/iu;

export function ticketVariantKind(title: string): TicketVariantKind | null {
  if (PREMIUM_SUFFIX.test(title)) return 'premium';
  if (FLEX_SUFFIX.test(title)) return 'flex';
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

export function ticketVariantLabel(title: string): string {
  const kind = ticketVariantKind(title);
  if (kind === 'premium') return 'Premium-Ticket';
  if (kind === 'flex') {
    const suffix = title.match(/flexticket(?:\s+[\p{L}\p{N}]+)*/iu)?.[0];
    return suffix ?? 'Flexticket';
  }
  return 'Standard-Ticket';
}
