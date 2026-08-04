import { canonicalizeVenue } from './canonicalizeVenue';
import { normalizeGenreGroup } from './genreGroup';

export type SavedDateFilter = 'all' | 'today' | 'tomorrow' | 'week' | 'weekend';
export type SavedSearchCriteria = {
  categories: string[];
  genres: string[];
  locations: string[];
  dateFilter: SavedDateFilter;
  freeOnly: boolean;
  availableOnly: boolean;
};
export type FilterEvent = {
  category: string | null;
  subcategory: string | null;
  location_name: string | null;
  start_date: string;
  end_date: string | null;
  price_info: string | null;
  sold_out: boolean | null;
};

const FREE_PRICE_PATTERN = /kostenlos|kostenfrei|gratis|umsonst|eintritt frei|free entry|\b0([.,]0+)?\s*€/i;
const addDays = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};
export function savedDateRange(filter: SavedDateFilter, today: string) {
  if (filter === 'today') return { from: today, to: today };
  if (filter === 'tomorrow') return { from: addDays(today, 1), to: addDays(today, 1) };
  if (filter === 'week') return { from: today, to: addDays(today, 6) };
  if (filter === 'weekend') {
    const day = new Date(`${today}T00:00:00Z`).getUTCDay();
    const saturday = addDays(today, (6 - day + 7) % 7);
    return { from: saturday, to: addDays(saturday, 1) };
  }
  return { from: today, to: null };
}
export function hasCriteria(c: SavedSearchCriteria) {
  return c.categories.length > 0 || c.genres.length > 0 || c.locations.length > 0 || c.dateFilter !== 'all' || c.freeOnly;
}
export function matchesSavedSearch(event: FilterEvent, c: SavedSearchCriteria, today: string): boolean {
  if (!hasCriteria(c)) return false;
  if (c.categories.length > 0 && (!event.category || !c.categories.includes(event.category))) return false;
  if (c.genres.length > 0 && !c.genres.includes(normalizeGenreGroup(event.subcategory ?? event.category))) return false;
  if (c.locations.length > 0 && !c.locations.includes(canonicalizeVenue(event.location_name))) return false;
  if (c.freeOnly && (!event.price_info || !FREE_PRICE_PATTERN.test(event.price_info))) return false;
  if (c.availableOnly && event.sold_out === true) return false;
  const { from, to } = savedDateRange(c.dateFilter, today);
  const eventEnd = event.end_date ?? event.start_date;
  return (to === null || event.start_date <= to) && eventEnd >= from;
}
