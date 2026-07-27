import type { SupabaseClient } from '@supabase/supabase-js';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'VibeApp-EventAggregator/1.0 (nicht-kommerzieller München Event-Aggregator)';

type Coords = { latitude: number; longitude: number };

const cache = new Map<string, Coords | null>();
let cacheLoaded = false;

async function loadCache(supabase: SupabaseClient) {
  if (cacheLoaded) return;
  const { data, error } = await supabase.from('venue_coordinates').select('*');
  if (!error && data) {
    for (const row of data) {
      cache.set(row.location_name, { latitude: row.latitude, longitude: row.longitude });
    }
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

  // Adresse ist der zuverlässigste Schlüssel (mehrere Säle an derselben Adresse
  // sollen sich nur einmal geokodieren lassen), sonst Location-Name + Stadt
  const cacheKey = address ?? `${locationName}, ${city}`;

  if (cache.has(cacheKey)) {
    return cache.get(cacheKey) ?? null;
  }

  const url = `${NOMINATIM_URL}?format=json&limit=1&q=${encodeURIComponent(cacheKey)}`;

  try {
    await sleep(1100); // Nominatim: max. 1 Anfrage/Sekunde einhalten
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
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