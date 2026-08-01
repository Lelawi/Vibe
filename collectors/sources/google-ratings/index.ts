import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

// Google-Bewertungen für Venues (bars/restaurants/spaetis) — bewusst über die
// offizielle Places API (New) statt Scraping (verstößt gegen Googles Nutzungs-
// bedingungen, siehe Diskussion im Chat 2026-08-01). Das rating-Feld gehört
// zum teuersten "Enterprise"-SKU von Place Details, das nur 1.000 kostenlose
// Anfragen/Monat hat (zurückgesetzt am Monatsersten, kein Rollover) — daher
// ein hartes Selbst-Limit weit darunter (MONTHLY_BUDGET) als zusätzliche
// Absicherung zum eigentlichen Schutz: einem hart eingestellten Quota-Limit
// in der Google Cloud Console (nicht nur ein Budget-Alert, das nur
// benachrichtigt statt zu blocken). Text Search zum Auflösen der place_id
// läuft im viel günstigeren Tier (id-only-Feldmaske) und ist hier nie der
// Flaschenhals.
//
// Rotation: jeden Tag werden bis zu DAILY_BATCH Venues mit dem ältesten (oder
// fehlendem) google_rating_checked_at neu abgefragt — bei ~2.500 Venues also
// gut 3 Monate für die erste vollständige Abdeckung, danach läuft die
// Rotation endlos weiter und hält die Bewertungen halbwegs aktuell.
const PLACES_API_BASE = 'https://places.googleapis.com/v1';
const MONTHLY_BUDGET = 900;
const DAILY_BATCH = 30;

interface RatingVenue {
  id: string;
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  google_place_id: string | null;
}

function startOfCurrentMonthUtc(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

// Ohne explizites Timeout hängt ein einzelner ausbleibender Response die
// gesamte Batch-Verarbeitung unbegrenzt lange auf (per Nutzer-Feedback
// beobachtet: Lauf stand nach der Start-Log-Zeile 5+ Minuten still, ohne
// Fehler oder Fortschritt) — 10s ist großzügig für eine einzelne REST-
// Antwort, aber verhindert einen unbegrenzten Hänger.
const REQUEST_TIMEOUT_MS = 10_000;

async function resolvePlaceId(apiKey: string, venue: RatingVenue): Promise<string | null> {
  const body: Record<string, unknown> = {
    textQuery: venue.address ? `${venue.name}, ${venue.address}` : `${venue.name}, München`,
  };
  // Location-Bias statt reiner Namenssuche: München hat mehrere Orte mit
  // ähnlichen/generischen Namen (z.B. "Goldstück", "Diba") — mit Koordinate
  // trifft die Suche zuverlässiger den richtigen Eintrag.
  if (venue.latitude != null && venue.longitude != null) {
    body.locationBias = {
      circle: { center: { latitude: venue.latitude, longitude: venue.longitude }, radius: 200.0 },
    };
  }
  const res = await fetch(`${PLACES_API_BASE}/places:searchText`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      // Nur die id anfragen — hält Text Search im günstigsten SKU (10.000
      // kostenlose Anfragen/Monat), das rating-Feld kommt separat über Place
      // Details, wo es ohnehin gebraucht wird.
      'X-Goog-FieldMask': 'places.id',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    console.warn(`[google-ratings] text search failed for "${venue.name}"`, res.status, await res.text().catch(() => ''));
    return null;
  }
  const data = (await res.json()) as { places?: { id: string }[] };
  return data.places?.[0]?.id ?? null;
}

async function fetchRating(apiKey: string, placeId: string): Promise<{ rating: number | null; count: number | null } | null> {
  const res = await fetch(`${PLACES_API_BASE}/places/${placeId}`, {
    headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'rating,userRatingCount' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    console.warn('[google-ratings] place details failed', placeId, res.status, await res.text().catch(() => ''));
    return null;
  }
  const data = (await res.json()) as { rating?: number; userRatingCount?: number };
  return { rating: data.rating ?? null, count: data.userRatingCount ?? null };
}

export async function run() {
  console.log('[google-ratings] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[google-ratings] missing supabase envs — skipping'); return; }
  if (!apiKey) { console.log('[google-ratings] missing GOOGLE_PLACES_API_KEY — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  // Verbrauch des laufenden Kalendermonats aus den Daten selbst ableiten
  // statt eines eigenen Zählers — bleibt auch nach einem fehlgeschlagenen
  // oder doppelt gestarteten Lauf korrekt, da es den tatsächlichen DB-Stand
  // widerspiegelt statt eines separat mitgeführten (und potenziell
  // divergierenden) Counters.
  const { count: usedThisMonth, error: countError } = await supabase
    .from('venues')
    .select('id', { count: 'exact', head: true })
    .gte('google_rating_checked_at', startOfCurrentMonthUtc());
  if (countError) { console.error('[google-ratings] could not determine monthly usage — aborting', countError); return; }

  const remainingBudget = Math.max(0, MONTHLY_BUDGET - (usedThisMonth ?? 0));
  const batchSize = Math.min(DAILY_BATCH, remainingBudget);
  console.log(`[google-ratings] used ${usedThisMonth ?? 0}/${MONTHLY_BUDGET} this month, processing ${batchSize} now`);
  if (batchSize <= 0) { console.log('[google-ratings] monthly budget exhausted — skipping until next month'); return; }

  const { data: venues, error: fetchError } = await supabase
    .from('venues')
    .select('id,name,address,latitude,longitude,google_place_id')
    .order('google_rating_checked_at', { ascending: true, nullsFirst: true })
    .limit(batchSize);
  if (fetchError) { console.error('[google-ratings] could not fetch venues', fetchError); return; }
  if (!venues || venues.length === 0) { console.log('[google-ratings] no venues found'); return; }

  let found = 0;
  let notFound = 0;
  let i = 0;
  for (const venue of venues as RatingVenue[]) {
    i++;
    console.log(`[google-ratings] (${i}/${venues.length}) ${venue.name}`);
    try {
      const placeId = venue.google_place_id ?? (await resolvePlaceId(apiKey, venue));
      if (!placeId) {
        notFound++;
        await supabase.from('venues').update({ google_rating_checked_at: new Date().toISOString() }).eq('id', venue.id);
        continue;
      }
      const rating = await fetchRating(apiKey, placeId);
      found++;
      await supabase
        .from('venues')
        .update({
          google_place_id: placeId,
          google_rating: rating?.rating ?? null,
          google_rating_count: rating?.count ?? null,
          google_rating_checked_at: new Date().toISOString(),
        })
        .eq('id', venue.id);
    } catch (err) {
      console.warn(`[google-ratings] error processing "${venue.name}"`, err);
    }
    // Kein Kostenfaktor (Abrechnung ist pro Anfrage, nicht pro Zeit) — eine
    // kleine Pause ist nur Rücksicht auf Googles QPS-Limits.
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log(`[google-ratings] done — ${found} ratings updated, ${notFound} not found on Google`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}

export default run;
