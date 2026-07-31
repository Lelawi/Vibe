import type { VenueType } from '../components/VenueListScreen';

// Erlaubt der Karte, exakt dieselbe gefilterte Ergebnismenge zu zeigen wie die
// Listenansicht, ohne die komplette Filterlogik (Suche/Kategorie/Genre/Ort/
// Datum/Küche/Mittagslunch/Favoriten/Nähe/...) ein zweites Mal zu
// implementieren: die Listen-Screens (index.tsx, VenueListScreen.tsx)
// schreiben ihr jeweils aktuell gefiltertes Ergebnis hier rein, die Karten-
// Screens (MapNative.web.tsx, VenueMapNative.web.tsx) lesen es beim Mounten.
// Modul-level statt Context/Store, weil es reine Übergabe zwischen zwei
// nacheinander gemounteten Screens ist, kein geteilter reaktiver State.
//
// Gibt es (noch) keinen Eintrag — z.B. Direktaufruf der Karte ohne vorherigen
// Listenbesuch in dieser Session, oder Umschalten zwischen Events/Bars/
// Restaurants direkt auf der Karte (siehe MapCategorySwitcher) — zeigt die
// Karte stattdessen alles ungefiltert; das ist der sinnvolle Default, wenn
// kein Filterkontext existiert, auf den man sich beziehen könnte.
export type MapVenueEntry = {
  id: string;
  name: string;
  address: string | null;
  latitude: number;
  longitude: number;
  opening_hours_raw: string | null;
  open: boolean | null;
  website: string | null;
  image_url: string | null;
  lunch_available: boolean;
  lunch_menu_url: string | null;
  beer_price_eur: number | null;
};

export type MapEventEntry = {
  id: string;
  title: string;
  location_name: string | null;
  latitude: number;
  longitude: number;
  start_date: string;
  start_time: string | null;
};

const lastFilteredVenues = new Map<VenueType, MapVenueEntry[]>();
let lastFilteredEvents: MapEventEntry[] | null = null;

export function setFilteredVenuesForMap(type: VenueType, venues: MapVenueEntry[]): void {
  lastFilteredVenues.set(type, venues);
}

export function getFilteredVenuesForMap(type: VenueType): MapVenueEntry[] | null {
  return lastFilteredVenues.get(type) ?? null;
}

export function setFilteredEventsForMap(events: MapEventEntry[]): void {
  lastFilteredEvents = events;
}

export function getFilteredEventsForMap(): MapEventEntry[] | null {
  return lastFilteredEvents;
}
