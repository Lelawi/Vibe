import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../app/.env') });

// Google-Bewertungen (+ Name/Öffnungszeiten/Website/Telefon als Nebenprodukt) für Venues
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
// Name/Öffnungszeiten/website/phone werden mit demselben Enterprise-Call
// mitgeliefert (gehören bereits zum bezahlten Tier). Website/Telefon werden
// nur dann übernommen, wenn wir
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
  displayName: string | null;
  rating: number | null;
  count: number | null;
  website: string | null;
  phone: string | null;
  businessStatus: string | null;
  openingHours: string | null;
}

type GooglePlaceTime = { day?: number; hour?: number; minute?: number };
type GooglePlacePeriod = { open?: GooglePlaceTime; close?: GooglePlaceTime };

const GOOGLE_DAY_ABBR = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const;
const OSM_DAY_ORDER = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'] as const;

function formatGoogleTime(time: GooglePlaceTime): string | null {
  if (!Number.isInteger(time.hour) || !Number.isInteger(time.minute)) return null;
  if (time.hour! < 0 || time.hour! > 23 || time.minute! < 0 || time.minute! > 59) return null;
  return `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`;
}

// Google liefert strukturierte Perioden mit Sonntag=0. Die App verwendet
// bewusst bereits überall OSM-opening_hours-Syntax; deshalb hier einmalig
// verlustfrei normalisieren, inklusive Pausen, Über-Mitternacht-Zeiten und
// expliziten Schließtagen.
export function googleOpeningHoursToOsm(periods: GooglePlacePeriod[] | null | undefined): string | null {
  if (!periods?.length) return null;
  const rangesByDay = new Map<string, string[]>();
  for (const period of periods) {
    const openDay = period.open?.day;
    if (!Number.isInteger(openDay) || openDay! < 0 || openDay! > 6 || !period.open) continue;
    const day = GOOGLE_DAY_ABBR[openDay!];
    const opens = formatGoogleTime(period.open);
    if (!opens) continue;
    let range: string;
    if (!period.close) {
      // Laut Places-API wird ein durchgehend geöffneter Tag ohne close
      // repräsentiert. Nur Mitternacht ist dafür ein plausibler Start.
      if (opens !== '00:00') continue;
      range = '00:00-24:00';
    } else {
      let closes = formatGoogleTime(period.close);
      if (!closes) continue;
      const closeDay = period.close.day;
      // Reale Google-Antwort bei Andys Seehäusl enthielt zusätzlich
      // 20:00-20:00 am selben Tag. Das ist ein leeres/ungültiges Intervall,
      // nicht "24 Stunden geöffnet" und muss verworfen werden, bevor der
      // OSM-Parser end<=start als Über-Mitternacht-Regel interpretiert.
      if (closes === opens) continue;
      if (closes === '00:00' && Number.isInteger(closeDay) && closeDay === (openDay! + 1) % 7) closes = '24:00';
      range = `${opens}-${closes}`;
    }
    if (!rangesByDay.has(day)) rangesByDay.set(day, []);
    rangesByDay.get(day)!.push(range);
  }
  if (rangesByDay.size === 0) return null;

  const schedules = OSM_DAY_ORDER.map((day) => rangesByDay.get(day)?.join(',') ?? 'off');
  const blocks: string[] = [];
  for (let start = 0; start < OSM_DAY_ORDER.length;) {
    let end = start;
    while (end + 1 < OSM_DAY_ORDER.length && schedules[end + 1] === schedules[start]) end++;
    const dayToken = start === end ? OSM_DAY_ORDER[start] : `${OSM_DAY_ORDER[start]}-${OSM_DAY_ORDER[end]}`;
    blocks.push(`${dayToken} ${schedules[start]}`);
    start = end + 1;
  }
  return blocks.join('; ');
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
    .replace(DIACRITICS_RE, '') // Umlaute/Akzente auf Basisbuchstaben reduzieren (ü -> u)
    // Bugfund 2026-08-12 (M.C. Mueller-Fall): unsere Venue-Namen kommen oft in
    // ASCII-Transliteration ("ue"/"oe"/"ae"/"ss"), Googles Namen dagegen mit
    // echten Umlauten ("ü"/"ö"/"ä"/"ß"). Nach dem Diakritika-Strip oben landet
    // "ü" bei "u", aber "ue" bleibt "ue" -- "Mueller" und "Müller" (-> "muller")
    // galten dadurch faelschlich als unterschiedliche Namen. Beide Schreib-
    // weisen hier auf dieselbe Form zusammenfuehren.
    .replace(/ue/g, 'u')
    .replace(/oe/g, 'o')
    .replace(/ae/g, 'a')
    .replace(/ss/g, 's')
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
  // Kompakte (leerzeichenfreie) Form zusaetzlich vergleichen: Google
  // schreibt manche Namen als ein Wort ("HEYLUIGI", "München72"), unsere
  // Venue-Namen mit Leerzeichen ("Hey Luigi", "München 72") — sonst
  // scheitert der sonst identische Name nur an der Leerzeichensetzung.
  const aCompact = a.replace(/ /g, '');
  const bCompact = b.replace(/ /g, '');
  const nameMatches =
    a.includes(b) ||
    b.includes(a) ||
    aCompact.includes(bCompact) ||
    bCompact.includes(aCompact) ||
    a.split(' ').some((w) => w.length >= 4 && b.split(' ').includes(w));
  if (!nameMatches) return false;
  const venuePlz = extractPostcode(venue.address);
  const candidatePlz = extractPostcode(candidate.address);
  if (venuePlz && candidatePlz) return venuePlz === candidatePlz;
  return true;
}

async function searchText(apiKey: string, textQuery: string, venue: RatingVenue): Promise<PlaceCandidate | null> {
  const body: Record<string, unknown> = { textQuery };
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
    console.warn(`[google-ratings] text search failed for "${textQuery}"`, res.status, await res.text().catch(() => ''));
    return null;
  }
  const data = (await res.json()) as { places?: { id: string; displayName?: { text: string }; formattedAddress?: string }[] };
  const place = data.places?.[0];
  if (!place) return null;
  return { id: place.id, name: place.displayName?.text ?? '', address: place.formattedAddress ?? null };
}

export async function resolvePlaceCandidate(apiKey: string, venue: RatingVenue): Promise<PlaceCandidate | null> {
  const textQuery = venue.address ? `${venue.name}, ${venue.address}` : `${venue.name}, München`;
  return searchText(apiKey, textQuery, venue);
}

// Fallback für den Fall, dass Name+OSM-Adresse keinen (oder nur einen von
// looksLikeSameVenue abgelehnten) Treffer liefert: eine zweite, bewusst
// gröbere Suche nur mit Name + "München" ohne die oft ungenaue/veraltete
// OSM-Adresse — die schadet der Google-Textsuche manchmal mehr, als sie
// hilft (Google-Kartendaten sind i.d.R. aktueller/besser verlinkt als die
// exakte OSM-Adresszeile). Ein identischer zweiter Versuch am nächsten Tag
// bringt nichts (deterministische Suche) — deshalb hier sofort im selben
// Lauf statt über mehrere Tage verteilt.
export async function resolvePlaceCandidateWithFallback(
  apiKey: string,
  venue: RatingVenue
): Promise<{ candidate: PlaceCandidate | null; usedFallback: boolean }> {
  const primary = await resolvePlaceCandidate(apiKey, venue);
  if (primary && looksLikeSameVenue(venue, primary)) return { candidate: primary, usedFallback: false };
  if (!venue.address) return { candidate: null, usedFallback: false };

  const fallback = await searchText(apiKey, `${venue.name}, München`, venue);
  return { candidate: fallback, usedFallback: true };
}

// Dritter Versuch, wenn Name+Adresse-Suche (auch der Fallback oben) leer
// bleibt: unsere Venue-Namen kommen oft unveraendert von OSM und sind
// manchmal generische Kategoriebezeichnungen statt des echten
// Geschaeftsnamens (z.B. "Schreib- und Tabakwaren" statt "Schreibwaren BAL",
// "M. C. Mueller" statt "M.C. Müller Burger und Bar") — Google kennt den
// echten Namen, findet ihn aber unter dem OSM-Namen nicht. Manuell geloest
// wurde das bisher immer gleich: den echten Namen von der eigenen Website
// (Seitentitel) holen und damit erneut suchen. Da der Name hier bewusst vom
// hinterlegten venue.name abweichen darf/soll, prüft looksLikeSameVenue()
// nicht — stattdessen wird strikt über die Postleitzahl abgesichert
// (sameApproxAddress), sonst kein Match.
export function sameApproxAddress(venue: RatingVenue, candidate: PlaceCandidate): boolean {
  const venuePlz = extractPostcode(venue.address);
  const candidatePlz = extractPostcode(candidate.address);
  return Boolean(venuePlz && candidatePlz && venuePlz === candidatePlz);
}

// Seitentitel enthalten oft Zusaetze ("Startseite", "| München", Claims) —
// nur den Teil vor dem ersten Trenner verwenden.
export function cleanWebsiteTitle(title: string): string | null {
  const cleaned = title.split(/[|\-–—•·]/)[0].trim();
  return cleaned.length >= 3 ? cleaned : null;
}

export async function resolvePlaceCandidateByWebsiteTitle(
  apiKey: string,
  venue: RatingVenue,
  websiteTitle: string
): Promise<PlaceCandidate | null> {
  const name = cleanWebsiteTitle(websiteTitle);
  if (!name || !venue.address) return null;
  const candidate = await searchText(apiKey, `${name}, ${venue.address}`, venue);
  if (candidate && sameApproxAddress(venue, candidate)) return candidate;
  return null;
}

export async function fetchDetails(apiKey: string, placeId: string): Promise<PlaceDetails | null> {
  const res = await fetch(`${PLACES_API_BASE}/places/${placeId}`, {
    headers: {
      'X-Goog-Api-Key': apiKey,
      // regularOpeningHours/websiteUri/nationalPhoneNumber gehören zum
      // selben Enterprise-Tier wie rating — kein höherer SKU, da ohnehin
      // bereits dieser Tarif für den Request ausgelöst wird.
      'X-Goog-FieldMask': 'displayName,rating,userRatingCount,websiteUri,nationalPhoneNumber,businessStatus,regularOpeningHours.periods',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    console.warn('[google-ratings] place details failed', placeId, res.status, await res.text().catch(() => ''));
    return null;
  }
  const data = (await res.json()) as {
    displayName?: { text?: string };
    rating?: number;
    userRatingCount?: number;
    websiteUri?: string;
    nationalPhoneNumber?: string;
    businessStatus?: string;
    regularOpeningHours?: { periods?: GooglePlacePeriod[] };
  };
  return {
    displayName: data.displayName?.text?.trim() || null,
    rating: data.rating ?? null,
    count: data.userRatingCount ?? null,
    website: data.websiteUri ?? null,
    phone: data.nationalPhoneNumber ?? null,
    businessStatus: data.businessStatus ?? null,
    openingHours: googleOpeningHoursToOsm(data.regularOpeningHours?.periods),
  };
}

export async function run() {
  console.log('[google-ratings] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  const requestedVenueIds = (process.env.GOOGLE_RATINGS_VENUE_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
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
  const batchSize = Math.min(DAILY_BATCH, remainingBudget, requestedVenueIds.length || DAILY_BATCH);
  console.log(`[google-ratings] used ${usedThisMonth ?? 0}/${MONTHLY_BUDGET} this month, processing ${batchSize} now${requestedVenueIds.length ? ' (targeted)' : ''}`);
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
  if (requestedVenueIds.length > 0) {
    // Gezielte Nachprüfung einzelner Feedback-/Diagnosefälle, ohne dafür
    // einen vollständigen 30er-Batch zu verbrauchen. Derselbe Budgetdeckel
    // und dieselbe Match-/Speicherlogik gelten weiterhin.
    const { data: requested, error: requestedError } = await supabase
      .from('venues')
      .select(VENUE_COLUMNS)
      .in('id', requestedVenueIds.slice(0, batchSize));
    if (requestedError) {
      console.error('[google-ratings] could not fetch targeted venues — aborting', requestedError);
      return;
    }
    venues = (requested ?? []).filter((venue) => !inactiveIds.has(venue.id as string)) as RatingVenue[];
  } else {
    // Direkt nach Einführung der Öffnungszeiten zuerst bereits eindeutig mit
    // Google verknüpfte Venues nachziehen. Der separate Checked-Zeitpunkt ist
    // wichtig: null kann sowohl "Google kennt keine Zeiten" als auch "noch
    // nie abgefragt" bedeuten und darf deshalb nicht allein als Queue dienen.
    const { data: missingHours, error: missingHoursError } = await supabase
      .from('venues')
      .select(VENUE_COLUMNS)
      .not('google_place_id', 'is', null)
      .is('google_opening_hours_checked_at', null)
      .order('google_rating_checked_at', { ascending: false, nullsFirst: false })
      .limit(batchSize + inactiveIds.size);
    if (missingHoursError) {
      console.error('[google-ratings] could not determine opening-hours backfill — aborting', missingHoursError);
      return;
    }
    for (const venue of missingHours ?? []) {
      if (venues.length >= batchSize) break;
      if (!inactiveIds.has(venue.id as string)) venues.push(venue as RatingVenue);
    }
  }

  if (requestedVenueIds.length === 0 && venues.length < batchSize) {
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
        // Fallback-Variante (Name+München ohne OSM-Adresse) wird sofort im
        // selben Lauf probiert, falls Variante 1 nichts Passendes liefert —
        // ein identischer zweiter Versuch am nächsten Tag würde ohnehin
        // dasselbe Ergebnis liefern (deterministische Suche), bringt also
        // keine neue Evidenz.
        const { candidate, usedFallback } = await resolvePlaceCandidateWithFallback(apiKey, venue);
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
          // Auch nach Fallback-Suche kein plausibler Google-Places-Treffer:
          // in die bestehende manuelle Review-Queue einreihen (dieselbe
          // Tabelle wie bei Nutzer-Meldungen über geschlossene Venues) statt
          // stillschweigend zu verwerfen. Idempotent per RPC (on conflict
          // venue_id) — reiht sich nicht doppelt ein, wenn der Fall schon
          // "pending" oder bereits entschieden ist. Kein automatisches
          // Löschen/Ausblenden hier: ein Google-Places-Nichttreffer allein
          // ist kein Existenzbeleg (siehe precheck-structured-reports.ts) —
          // die eigentliche Entscheidung braucht zusätzlich eine echte
          // Websuche, die dieses Skript nicht leisten kann.
          const { error: queueError } = await supabase.rpc('submit_venue_closure_report', { p_venue_id: venue.id });
          if (queueError) console.warn(`[google-ratings] could not queue "${venue.name}" for review`, queueError.message);
          else console.log(`[google-ratings] "${venue.name}" auch mit Fallback${usedFallback ? '' : ' (keine Adresse für Fallback vorhanden)'} nicht gefunden — zur Review-Queue hinzugefügt`);
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
        google_opening_hours: details?.openingHours ?? null,
        google_rating_checked_at: new Date().toISOString(),
        google_opening_hours_checked_at: new Date().toISOString(),
        google_not_found_streak: 0,
      };
      // Sobald die Zuordnung über eine validierte bzw. bereits gespeicherte
      // Place-ID feststeht, ist Googles aktueller Anzeigename die führende
      // Bezeichnung in der App. Der ursprüngliche OSM-Name bleibt im Feld
      // `name` erhalten und kann weiterhin zur Herkunftskontrolle dienen.
      if (details?.displayName) update.name_override = details.displayName;
      // Nur auffüllen, nie überschreiben — siehe Kommentar am Dateianfang.
      if (!venue.website && details?.website) update.website = details.website;
      if (!venue.phone && details?.phone) update.phone = details.phone;
      await supabase.from('venues').update(update).eq('id', venue.id);

      // Bugfund 2026-08-13 (per Nutzer-Meldung "Cafe Bar Omonoia"): bisher
      // wurde CLOSED_PERMANENTLY hier nur im Feld google_business_status
      // abgelegt, ohne je eine Konsequenz -- keine Schliessungsmeldung,
      // kein Ausblenden in der App (siehe 0044_venues_closed_at.sql). Diese
      // eindeutige Google-Evidenz braucht keine manuelle Pruefung wie ein
      // reiner Nichttreffer (siehe precheck-structured-reports.ts, das
      // dieselbe Logik fuer den reaktiven/gemeldeten Pfad schon hatte) --
      // direkt bestaetigen statt nur zu speichern.
      if (details?.businessStatus === 'CLOSED_PERMANENTLY') {
        // Falls ein Mensch diese Venue schon einmal explizit als "existiert
        // noch" abgelehnt hatte, nicht stillschweigend ueberstimmen -- neu
        // in die Pruefwarteschlange einreihen (macht submit_venue_closure_
        // report ohnehin bei 'rejected'), aber die Entscheidung selbst
        // einem Menschen ueberlassen statt automatisch zu kippen.
        const { data: existing } = await supabase
          .from('venue_closure_reports')
          .select('status')
          .eq('venue_id', venue.id)
          .maybeSingle();
        const { error: queueError } = await supabase.rpc('submit_venue_closure_report', { p_venue_id: venue.id });
        if (queueError) {
          console.warn(`[google-ratings] could not queue closure for "${venue.name}"`, queueError.message);
        } else if (existing?.status !== 'rejected') {
          await supabase
            .from('venue_closure_reports')
            .update({
              status: 'confirmed',
              review_note: 'Automatisch bestätigt: eindeutig zugeordneter Google-Places-Eintrag ist dauerhaft geschlossen (gefunden während der regulären Rotation, nicht durch eine Nutzermeldung).',
            })
            .eq('venue_id', venue.id)
            .eq('status', 'pending');
        } else {
          console.log(`[google-ratings] "${venue.name}" zeigt CLOSED_PERMANENTLY, war aber zuvor von einem Menschen abgelehnt — zur erneuten manuellen Pruefung eingereiht statt automatisch bestaetigt.`);
        }
      }
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
