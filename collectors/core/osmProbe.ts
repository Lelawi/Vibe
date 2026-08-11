// Leichte, unabhaengige Zweitquelle fuer die Closure-Vorpruefung: prueft nur,
// ob Name+Adresse einer Venue noch einen OSM/Nominatim-Treffer liefert. Kein
// Beleg fuer sich allein (OSM kennt viele kleine Lokale ohnehin nie, siehe
// 0028_venues_google_not_found_streak.sql), aber als zweites, von Google
// unabhaengiges Signal in Kombination mit einem Google-Nichttreffer + toter/
// fehlender Website nutzbar (siehe precheck-structured-reports.ts). Nutzt
// dieselbe Nominatim-API wie core/geocode.ts, aber bewusst getrennt
// gehalten (andere Fragestellung: "existiert noch?" statt "wo liegt es?").

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'VibeApp-EventAggregator/1.0 (nicht-kommerzieller München Event-Aggregator)';

export type OsmProbe = { outcome: 'found' | 'not_found' | 'unclear'; query: string; reason: string };

let lastRequestAt = 0;
async function throttle() {
  // Nominatim: max. 1 Anfrage/Sekunde einhalten
  const wait = 1100 - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

export async function probeVenueOnOsm(name: string, address: string | null): Promise<OsmProbe> {
  const query = [name, address].filter(Boolean).join(', ');
  if (!query) return { outcome: 'unclear', query, reason: 'Kein Name/Adresse fuer Suche vorhanden' };
  await throttle();
  const url = `${NOMINATIM_URL}?format=json&limit=1&q=${encodeURIComponent(query)}`;
  try {
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return { outcome: 'unclear', query, reason: `Status ${response.status}` };
    const results = await response.json();
    if (Array.isArray(results) && results.length > 0) return { outcome: 'found', query, reason: 'OSM/Nominatim-Treffer vorhanden' };
    return { outcome: 'not_found', query, reason: 'Kein OSM/Nominatim-Treffer' };
  } catch (err) {
    return { outcome: 'unclear', query, reason: err instanceof Error ? err.message : String(err) };
  }
}
