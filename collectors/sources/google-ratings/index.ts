import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

// Google-Bewertungen (+ Website/Telefon als Nebenprodukt) für Venues
// (bars/restaurants/spaetis) — bewusst über die offizielle Places API (New)
// statt Scraping (verstößt gegen Googles Nutzungsbedingungen, siehe
// Diskussion im Chat 2026-08-01). Das rating-Feld gehört zum teuersten
// "Enterprise"-SKU von Place Details, das nur 1.000 kostenlose
// Anfragen/Monat hat (zurückgesetzt am Monatsersten, kein Rollover) — daher
// ein hartes Selbst-Limit weit darunter (MONTHLY_BUDGET) als zusätzliche
// Absicherung zum eigentlichen Schutz: einem hart eingestellten Quota-Limit
// in der Google Cloud Console (nicht nur ein Budget-Alert, das nur
// benachrichtigt statt zu blocken). Text Search zum Auflösen der place_id
// läuft im viel günstigeren Tier und ist hier nie der Flaschenhals.
// website/phone werden mit demselben Enterprise-Call kostenlos mitgeliefert
// (gehören bereits zum bezahlten Tier) und nur dann übernommen, wenn wir
// dafür noch keinen Wert haben — Google ist im Schnitt aktueller als OSM
// (siehe Feder-Bar-Fall), aber überschreibt nichts, um Bestandsdaten nicht
// versehentlich durch einen Text-Search-Fehltreffer zu ersetzen.
//
// Rotation: jeden Tag werden bis zu DAILY_BATCH Venues mit dem ältesten (oder
// fehlendem) google_rating_checked_at neu abgefragt — bei ~2.500 Venues also
// gut 3 Monate für die erste vollständige Abdeckung, danach läuft die
// Rotation endlos weiter und hält die Bewertungen halbwegs aktuell.
const PLACES_API_BASE = 'https://places.googleapis.com/v1';
const MONTHLY_BUDGET = 900;
const DAILY_BATCH = 30;
// Ohne explizites Timeout hängt ein einzelner ausbleibender Response die
// gesamte Batch-Verarbeitung unbegrenzt lange auf (per Nutzer-Feedback
// beobachtet: Lauf stand nach der Start-Log-Zeile 5+ Minuten still, ohne
// Fehler oder Fortschritt) — 10s ist großzügig für eine einzelne REST-
// Antwort, aber verhindert einen unbegrenzten Hänger.
const REQUEST_TIMEOUT_MS = 10_000;

export interface RatingVenue {
  id: string;
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  website: string | null;
  phone: string | null;
  google_place_id: string | null;
  google_not_found_streak: number | null;
}

export interface PlaceCandidate {
  id: string;
  name: string;
  address: string | null;
}

export interface PlaceDetails {
  rating: number | null;
  count: number | null;
  website: string | null;
  phone: string | null;
  businessStatus: string | null;
}

function startOfCurrentMonthUtc(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

// Kombinierende diakritische Zeichen (U+0300-U+036F) nach NFD-Zerlegung —
// per \u-Escape statt eingebetteter Sonderzeichen im Quelltext, um
// Encoding-Probleme beim Bearbeiten dieser Datei zu vermeiden.
const DIACRITICS_RE = new RegExp(`[${String.fromCharCode(0x0300)}-${String.fromCharCode(0x036f)}]`, 'g');

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(DIACRITICS_RE, '') // Umlaute/Akzente auf Basisbuchstaben reduzieren
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractPostcode(s: string | null): string | null {
  if (!s) return null;
  return s.match(/\b\d{5}\b/)?.[0] ?? null;
}

// Fehltreffer-Absicherung für die Text-Search-Zuordnung: München hat mehrere
// Orte mit sehr ähnlichen/generischen Namen (z.B. "Diba", "Charlatan",
// "Goldstück" — diese Session voll von Beispielen), ein Location-Bias allein
// garantiert keinen korrekten Treffer. Bewusst kein hartes Ausschlusskriterium
// bei fehlender Adresse (viele Spätis haben in unserer DB gar keine) — dann
// verlässt sich die Prüfung nur auf den Namen.
export function looksLikeSameVenue(venue: RatingVenue, candidate: PlaceCandidate): boolean {
  const a = normalize(venue.name);
  const b = normalize(candidate.name);
  if (!a || !b) return false;
  const nameMatches =
    a.includes(b) ||
    b.includes(a) ||
    a.split(' ').some((w) => w.length >= 4 && b.split(' ').includes(w));
  if (!nameMatches) return false;
  const venuePlz = extractPostcode(venue.address);
  const candidatePlz = extractPostcode(candidate.address);
  if (venuePlz && candidatePlz) return venuePlz === candidatePlz;
  return true;
}

export async function resolvePlaceCandidate(apiKey: string, venue: RatingVenue): Promise<PlaceCandidate | null> {
  const body: Record<string, unknown> = {
    textQuery: venue.address ? `${venue.name}, ${venue.address}` : `${venue.name}, München`,
  };
  // Location-Bias statt reiner Namenssuche: siehe looksLikeSameVenue oben.
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
      // id/displayName/formattedAddress sind alle im günstigsten SKU
      // (Essentials, 10.000 kostenlose Anfragen/Monat) — displayName und
      // formattedAddress kosten hier nichts extra, werden aber für die
      // Fehltreffer-Absicherung (looksLikeSameVenue) gebraucht.
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    console.warn(`[google-ratings] text search failed for "${venue.name}"`, res.status, await res.text().catch(() => ''));
    return null;
  }
  const data = (await res.json()) as { places?: { id: string; displayName?: { text: string }; formattedAddress?: string }[] };
  const place = data.places?.[0];
  if (!place) return null;
  return { id: place.id, name: place.displayName?.text ?? '', address: place.formattedAddress ?? null };
}

export async function fetchDetails(apiKey: string, placeId: string): Promise<PlaceDetails | null> {
  const res = await fetch(`${PLACES_API_BASE}/places/${placeId}`, {
    headers: {
      'X-Goog-Api-Key': apiKey,
      // websiteUri/nationalPhoneNumber/businessStatus gehören alle zum
      // selben Enterprise-Tier wie rating — kein zusätzlicher Kostenfaktor,
      // da ohnehin schon der teuerste SKU für diesen Request bezahlt wird.
      'X-Goog-FieldMask': 'rating,userRatingCount,websiteUri,nationalPhoneNumber,businessStatus',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    console.warn('[google-ratings] place details failed', placeId, res.status, await res.text().catch(() => ''));
    return null;
  }
  const data = (await res.json()) as {
    rating?: number;
    userRatingCount?: number;
    websiteUri?: string;
    nationalPhoneNumber?: string;
    businessStatus?: string;
  };
  return {
    rating: data.rating ?? null,
    count: data.userRatingCount ?? null,
    website: data.websiteUri ?? null,
    phone: data.nationalPhoneNumber ?? null,
    businessStatus: data.businessStatus ?? null,
  };
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

  // Offene Schließungsmeldungen werden NICHT mehr täglich bevorzugt erneut
  // abgefragt: drei identische Google-Nichttreffer an drei Folgetagen sind
  // keine drei unabhängigen Belege. Ungeklärte Fälle bleiben bis zur
  // wöchentlichen manuellen Entscheidung offen (weekly-review.ts). Die
  // normale Rotation darf weiterhin gelegentlich frische Evidenz liefern.
  const VENUE_COLUMNS = 'id,name,address,latitude,longitude,website,phone,google_place_id,google_not_found_streak';
  // Bestätigt geschlossene Venues werden in der App bereits ausgeblendet und
  // dürfen deshalb auch kein knappes Google-Places-Budget mehr verbrauchen.
  // Der bestehende Closure-Status ist hier die Quelle der Wahrheit; ein
  // separates deleted_at-Feld besitzt das aktuelle venues-Schema nicht.
  const { data: closureReports, error: closureReportsError } = await supabase
    .from('venue_closure_reports')
    .select('venue_id,status')
    .eq('status', 'confirmed');
  if (closureReportsError) {
    console.error('[google-ratings] could not determine inactive venues — aborting', closureReportsError);
    return;
  }
  const inactiveIds = new Set(
    (closureReports ?? []).map((r) => r.venue_id as string)
  );

  let venues: RatingVenue[] = [];
  if (venues.length < batchSize) {
    const { data: rest, error: fetchError } = await supabase
      .from('venues')
      .select(VENUE_COLUMNS)
      .order('google_rating_checked_at', { ascending: true, nullsFirst: true })
      // Genügend Zeilen laden, damit lokal herausgefilterte, bestätigt
      // geschlossene Venues den Batch nicht verkleinern.
      .limit(batchSize - venues.length + inactiveIds.size);
    if (fetchError) { console.error('[google-ratings] could not fetch venues', fetchError); return; }
    const existingIds = new Set(venues.map((v) => v.id));
    for (const v of rest ?? []) {
      if (venues.length >= batchSize) break;
      if (!existingIds.has(v.id) && !inactiveIds.has(v.id)) venues.push(v);
    }
  }
  if (venues.length === 0) { console.log('[google-ratings] no venues found'); return; }

  let found = 0;
  let notFound = 0;
  let rejectedMatch = 0;
  let i = 0;
  for (const venue of venues as RatingVenue[]) {
    i++;
    console.log(`[google-ratings] (${i}/${venues.length}) ${venue.name}`);
    try {
      let placeId = venue.google_place_id;
      if (!placeId) {
        // Frische Auflösung: die Kandidaten-Antwort wird gegen looksLikeSameVenue
        // geprüft, bevor irgendetwas übernommen wird — ein bereits zwischen-
        // gespeicherter place_id (aus einem früheren Lauf) wurde schon einmal
        // validiert und wird nicht jeden Tag erneut geprüft.
        const candidate = await resolvePlaceCandidate(apiKey, venue);
        if (!candidate || !looksLikeSameVenue(venue, candidate)) {
          if (candidate) rejectedMatch++;
          notFound++;
          // Der frühere Drei-Treffer-Streak wird bewusst nicht fortgeführt:
          // wiederholte Nichtzuordnung ist keine sichere Schließungsbestätigung.
          await supabase
            .from('venues')
            .update({
              google_rating_checked_at: new Date().toISOString(),
              google_not_found_streak: 0,
            })
            .eq('id', venue.id);
          continue;
        }
        placeId = candidate.id;
      }
      const details = await fetchDetails(apiKey, placeId);
      found++;
      const update: Record<string, unknown> = {
        google_place_id: placeId,
        google_rating: details?.rating ?? null,
        google_rating_count: details?.count ?? null,
        google_business_status: details?.businessStatus ?? null,
        google_rating_checked_at: new Date().toISOString(),
        google_not_found_streak: 0,
      };
      // Nur auffüllen, nie überschreiben — siehe Kommentar am Dateianfang.
      if (!venue.website && details?.website) update.website = details.website;
      if (!venue.phone && details?.phone) update.phone = details.phone;
      await supabase.from('venues').update(update).eq('id', venue.id);
    } catch (err) {
      console.warn(`[google-ratings] error processing "${venue.name}"`, err);
    }
    // Kein Kostenfaktor (Abrechnung ist pro Anfrage, nicht pro Zeit) — eine
    // kleine Pause ist nur Rücksicht auf Googles QPS-Limits.
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log(
    `[google-ratings] done — ${found} updated, ${notFound} not found (${rejectedMatch} rejected as likely mismatch)`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}

export default run;
