import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';
import { canonicalizeVenue } from './venue';
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
export type SavedSearch = {
  id: string;
  name: string;
  criteria: SavedSearchCriteria;
  enabled: boolean;
};
export type SearchableEvent = {
  category: string | null;
  subcategory: string | null;
  location_name: string | null;
  start_date: string;
  end_date: string | null;
  price_info: string | null;
  sold_out: boolean | null;
};

const STORAGE_KEY = 'vibe:saved-searches';
const FREE_PRICE_PATTERN = /kostenlos|kostenfrei|gratis|umsonst|eintritt frei|free entry|\b0([.,]0+)?\s*€/i;
let cache: SavedSearch[] | null = null;
const listeners = new Set<(searches: SavedSearch[]) => void>();

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function savedDateRange(filter: SavedDateFilter, today: string): { from: string; to: string | null } {
  if (filter === 'today') return { from: today, to: today };
  if (filter === 'tomorrow') {
    const tomorrow = addDays(today, 1);
    return { from: tomorrow, to: tomorrow };
  }
  if (filter === 'week') return { from: today, to: addDays(today, 6) };
  if (filter === 'weekend') {
    const day = new Date(`${today}T00:00:00Z`).getUTCDay();
    const saturday = addDays(today, (6 - day + 7) % 7);
    return { from: saturday, to: addDays(saturday, 1) };
  }
  return { from: today, to: null };
}

export function hasSavedSearchCriteria(criteria: SavedSearchCriteria): boolean {
  return criteria.categories.length > 0 || criteria.genres.length > 0 ||
    criteria.locations.length > 0 || criteria.dateFilter !== 'all' || criteria.freeOnly;
}

// ODER innerhalb einer Dimension, UND zwischen Dimensionen. Diese Semantik
// ist absichtlich identisch zum Notification-Collector und verhindert den
// früheren Fehler, bei dem z.B. Kategorie ODER Genre ODER Ort genügte.
export function matchesSavedSearch(event: SearchableEvent, criteria: SavedSearchCriteria, today: string): boolean {
  if (!hasSavedSearchCriteria(criteria)) return false;
  if (criteria.categories.length > 0 && (!event.category || !criteria.categories.includes(event.category))) return false;
  if (criteria.genres.length > 0 && !criteria.genres.includes(normalizeGenreGroup(event.subcategory ?? event.category))) return false;
  if (criteria.locations.length > 0 && !criteria.locations.includes(canonicalizeVenue(event.location_name))) return false;
  if (criteria.freeOnly && (!event.price_info || !FREE_PRICE_PATTERN.test(event.price_info))) return false;
  if (criteria.availableOnly && event.sold_out === true) return false;

  const { from, to } = savedDateRange(criteria.dateFilter, today);
  const eventEnd = event.end_date ?? event.start_date;
  return (to === null || event.start_date <= to) && eventEnd >= from;
}

async function load(): Promise<SavedSearch[]> {
  if (cache) return cache;
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  cache = raw ? JSON.parse(raw) : [];
  return cache!;
}
async function persist(searches: SavedSearch[]) {
  cache = searches;
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(searches));
  listeners.forEach((listener) => listener(searches));
}
export async function saveSearch(search: SavedSearch) {
  const current = await load();
  await persist([...current.filter((item) => item.id !== search.id), search]);
}
export async function removeSavedSearch(id: string) {
  await persist((await load()).filter((item) => item.id !== id));
}

export function useSavedSearches() {
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>(cache ?? []);
  useEffect(() => {
    let mounted = true;
    load().then((items) => { if (mounted) setSavedSearches(items); });
    const listener = (items: SavedSearch[]) => setSavedSearches(items);
    listeners.add(listener);
    return () => { mounted = false; listeners.delete(listener); };
  }, []);
  return { savedSearches, saveSearch, removeSavedSearch };
}
