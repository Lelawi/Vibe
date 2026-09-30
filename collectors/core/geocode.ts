import type { SupabaseClient } from '@supabase/supabase-js';
import { getCanonicalVenue, getVenueAddress } from './known_venues';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
// Großraum München (inkl. Umland). Ohne Begrenzung fand Nominatim z.B.
// "Leopoldstr. 13" in Berlin und "München, München" in Brandenburg — der
// falsche Treffer blieb dann dauerhaft im Cache (Fund 2026-09-30).
const MUNICH_VIEWBOX = '11.0,48.5,12.2,47.7'; // lon_min,lat_max,lon_max,lat_min
const USER_AGENT = 'VibeApp-EventAggregator/1.0 (nicht-kommerzieller München Event-Aggregator)';

type Coords = { latitude: number; longitude: number };

const cache = new Map<string, Coords | null>();
let cacheLoaded = false;

async function loadCache(supabase: SupabaseClient) {
  if (cacheLoaded) return;
  // Seitenweise (Supabase liefert max. 1000 Zeilen pro Anfrage).
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('venue_coordinates')
      .select('location_name,latitude,longitude')
      .order('location_name', { ascending: true })
      .range(from, from + 999);
    if (error || !data) break;
    for (const row of data) {
      cache.set(row.location_name, { latitude: row.latitude, longitude: row.longitude });
    }
    if (data.length < 1000) break;
  }
  cacheLoaded = true;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Ermittelt Koordinaten für eine Location - nutzt zuerst den Cache,
// fragt nur bei unbekannten Orten die Nominatim-API an (max. 1x pro Sekunde erlaubt)
export async function getCoordinates(
  supabase: SupabaseClient,
  locationName: string,
  address: string | null,
  city: string
): Promise<Coords | null> {
  await loadCache(supabase);

  // Normalize known venue names to a canonical name to improve geocoding
  const canonical = getCanonicalVenue(locationName) ?? locationName;

  // Wenn keine Adresse vom Collector übergeben wird, nutze eine bekannte Adresse
  // für den canonical Namen, falls verfügbar. Adresse ist der zuverlässigste
  // Schlüssel (mehrere Säle an derselben Adresse sollen sich nur einmal
  // geokodieren lassen), sonst canonical Name + Stadt
  const resolvedAddress = address ?? getVenueAddress(canonical) ?? null;
  const cacheKey = resolvedAddress ?? `${canonical}, ${city}`;

  if (cache.has(cacheKey)) {
    return cache.get(cacheKey) ?? null;
  }

  // Adresse ohne Stadt ("Leopoldstr. 13") um die Stadt ergänzen, sonst sucht
  // Nominatim deutschlandweit nach der Straße.
  const query = resolvedAddress && !/münchen|munich/i.test(resolvedAddress)
    ? `${resolvedAddress}, ${city}`
    : cacheKey;
  const url = `${NOMINATIM_URL}?format=json&limit=1&countrycodes=de&viewbox=${MUNICH_VIEWBOX}&bounded=1&q=${encodeURIComponent(query)}`;

  try {
    await sleep(1100); // Nominatim: max. 1 Anfrage/Sekunde einhalten
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Status ${response.status}`);
    const results = await response.json();

    if (!Array.isArray(results) || results.length === 0) {
      console.warn(`Keine Koordinaten gefunden für: ${cacheKey}`);
      cache.set(cacheKey, null);
      return null;
    }

    const coords: Coords = {
      latitude: parseFloat(results[0].lat),
      longitude: parseFloat(results[0].lon),
    };

    cache.set(cacheKey, coords);
    await supabase
      .from('venue_coordinates')
      .upsert({ location_name: cacheKey, ...coords }, { onConflict: 'location_name' });

    return coords;
  } catch (err) {
    console.warn(`Geokodierung fehlgeschlagen für "${cacheKey}":`, err);
    cache.set(cacheKey, null);
    return null;
  }
}