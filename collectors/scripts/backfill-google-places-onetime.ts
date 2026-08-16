import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import {
  resolvePlaceCandidateWithFallback,
  googleOpeningHoursToOsm,
  type RatingVenue,
} from '../sources/google-ratings/index.js';

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../../app/.env') });

// EINMALIGER Sweep, finanziert aus befristetem Google-Cloud-Guthaben
// (260€, verfaellt 80 Tage nach 2026-08-16, gleiche Rechnungsstelle wie
// GOOGLE_PLACES_API_KEY -- per Nutzer-Ruecksprache bestaetigt). Bewusst NICHT
// in collect-all.ts und NICHT als "npm run"-Dauerquelle gedacht -- laeuft
// nur manuell, ein paar Mal, bis der Rueckstand (google_place_id IS NULL)
// abgearbeitet oder das Guthaben aufgebraucht ist. Der taegliche
// google-ratings-Collector (960/Monat-Selbstdeckel, $0/Monat) bleibt davon
// unberuehrt und laeuft nach Ende dieses Sweeps unveraendert weiter --
// KEINE neue Dauerkost, siehe CLAUDE.md "Google ratings".
//
// Kostenrahmen (Stand 2026-08-16, Google-Preisliste): Place Details
// Enterprise (rating+photos im selben Field-Mask, kein Aufpreis fuer
// photos) 1.000 kostenlos/Monat, danach 20€/1.000. Rueckstand aktuell
// ~3.242 Venues ohne google_place_id -- das begrenzt die maximal moegliche
// Anzahl bezahlter Enterprise-Calls durch dieses Skript von selbst auf
// ~3.242 (jede Venue wird nach Erfolg aus der Zielmenge entfernt, kann
// also nie zweimal bezahlt abgefragt werden) => Kostendeckel ~65€ selbst im
// Worst Case. Place Photo (Media-Download) hat ein EIGENES, separates
// 1.000-kostenlos/Monat-Kontingent, danach 7€/1.000; PHOTO_DOWNLOAD_CAP
// unten deckelt das zusaetzlich hart auf 2.000 Lifetime (~8€ worst case).
// Zusammen weit unter dem verfuegbaren Guthaben, mit deutlichem Puffer fuer
// Wechselkurs-/Rundungsunsicherheit. BATCH_SIZE bewusst klein (Default 300)
// -- der Sweep laeuft in mehreren manuell angestossenen, ueberwachten
// Durchgaengen statt einem einzigen blinden Grosslauf.
//
// Google erlaubt kein dauerhaftes Speichern der von der Photos-API
// zurueckgegebenen photoUri ("the name can expire") -- deshalb wird das
// Foto einmalig heruntergeladen und in den eigenen, oeffentlichen
// venue-photos-Bucket hochgeladen (0047_venue_photos_bucket.sql) statt die
// Google-URL direkt zu speichern. Kein GCP-Quota-Zugriff aus diesem Repo
// (kein gcloud/Service-Account-Key, siehe Kommentar in google-ratings/
// index.ts) -- diese Skript-eigenen Deckel sind die einzige technische
// Kostenschranke, die von hier aus gesetzt werden kann; eine harte Quota in
// der GCP Console bleibt trotzdem empfohlen.
const PLACES_API_BASE = 'https://places.googleapis.com/v1';
const BATCH_SIZE = Number(process.env.BACKFILL_BATCH_SIZE ?? 300);
const PHOTO_DOWNLOAD_CAP = 2000;
const PHOTO_MAX_WIDTH_PX = 800;
const REQUEST_TIMEOUT_MS = 10_000;
const VENUE_PHOTOS_BUCKET = 'venue-photos';
// Eindeutiger, host-unabhaengiger Teilstring einer von uns gehosteten
// Venue-Foto-URL -- dient nur der Zaehlung des bisherigen Verbrauchs
// (siehe Kommentar oben), nicht dem tatsaechlichen Bucket-Zugriff.
const VENUE_PHOTOS_URL_MARKER = `/object/public/${VENUE_PHOTOS_BUCKET}/`;

interface PlacesPhoto {
  name?: string;
}

interface DetailsWithPhotos {
  displayName: string | null;
  rating: number | null;
  count: number | null;
  website: string | null;
  phone: string | null;
  businessStatus: string | null;
  openingHours: string | null;
  photoName: string | null;
}

// Eigene Details-Abfrage statt der geteilten fetchDetails() aus
// google-ratings/index.ts: nur der zusaetzliche photos-Teil des Field-Masks
// unterscheidet sich (gleicher Enterprise-SKU, kein Mehrpreis), der
// tägliche Produktions-Collector bleibt dadurch komplett unangetastet statt
// ihn fuer diesen einmaligen Zweck mit zu aendern.
async function fetchDetailsWithPhotos(apiKey: string, placeId: string): Promise<DetailsWithPhotos | null> {
  const res = await fetch(`${PLACES_API_BASE}/places/${placeId}`, {
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask':
        'displayName,rating,userRatingCount,websiteUri,nationalPhoneNumber,businessStatus,regularOpeningHours.periods,photos.name',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    console.warn('[backfill-google-places] place details failed', placeId, res.status, await res.text().catch(() => ''));
    return null;
  }
  const data = (await res.json()) as {
    displayName?: { text?: string };
    rating?: number;
    userRatingCount?: number;
    websiteUri?: string;
    nationalPhoneNumber?: string;
    businessStatus?: string;
    regularOpeningHours?: { periods?: any[] };
    photos?: PlacesPhoto[];
  };
  return {
    displayName: data.displayName?.text?.trim() || null,
    rating: data.rating ?? null,
    count: data.userRatingCount ?? null,
    website: data.websiteUri ?? null,
    phone: data.nationalPhoneNumber ?? null,
    businessStatus: data.businessStatus ?? null,
    openingHours: googleOpeningHoursToOsm(data.regularOpeningHours?.periods),
    photoName: data.photos?.[0]?.name ?? null,
  };
}

// photoUri ist laut Google nicht cachebar/kann ablaufen -- deshalb sofort
// im selben Lauf herunterladen und weiterreichen, nie zwischenspeichern.
async function fetchGooglePhotoBytes(apiKey: string, photoName: string): Promise<Buffer | null> {
  const mediaRes = await fetch(
    `${PLACES_API_BASE}/${photoName}/media?maxWidthPx=${PHOTO_MAX_WIDTH_PX}&skipHttpRedirect=true&key=${apiKey}`,
    { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
  );
  if (!mediaRes.ok) {
    console.warn('[backfill-google-places] photo media request failed', photoName, mediaRes.status);
    return null;
  }
  const { photoUri } = (await mediaRes.json()) as { photoUri?: string };
  if (!photoUri) return null;
  const imgRes = await fetch(photoUri, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!imgRes.ok) return null;
  return Buffer.from(await imgRes.arrayBuffer());
}

export async function run() {
  console.log('[backfill-google-places] starting ONE-TIME sweep (nicht Teil von collect-all)');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[backfill-google-places] missing supabase envs — skipping'); return; }
  if (!apiKey) { console.log('[backfill-google-places] missing GOOGLE_PLACES_API_KEY — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  // Bisherigen Foto-Verbrauch aus dem DB-Zustand ableiten (gleiches Prinzip
  // wie MONTHLY_BUDGET in google-ratings/index.ts) statt eines separaten,
  // zwischen Laeufen potenziell divergierenden Zaehlers.
  const { count: photosUsed, error: photosUsedError } = await supabase
    .from('venues')
    .select('id', { count: 'exact', head: true })
    .like('image_url', `%${VENUE_PHOTOS_URL_MARKER}%`);
  if (photosUsedError) { console.error('[backfill-google-places] could not determine photo usage — aborting', photosUsedError); return; }
  let photoBudgetRemaining = Math.max(0, PHOTO_DOWNLOAD_CAP - (photosUsed ?? 0));
  console.log(`[backfill-google-places] photo budget: ${photosUsed ?? 0}/${PHOTO_DOWNLOAD_CAP} lifetime used, ${photoBudgetRemaining} remaining this run`);

  const { data: closureReports, error: closureReportsError } = await supabase
    .from('venue_closure_reports')
    .select('venue_id,status')
    .eq('status', 'confirmed');
  if (closureReportsError) { console.error('[backfill-google-places] could not determine inactive venues — aborting', closureReportsError); return; }
  const inactiveIds = new Set((closureReports ?? []).map((r) => r.venue_id as string));

  const VENUE_COLUMNS = 'id,name,address,latitude,longitude,website,phone,image_url,google_place_id,google_not_found_streak';
  const { data: rawVenues, error: fetchError } = await supabase
    .from('venues')
    .select(VENUE_COLUMNS)
    .is('google_place_id', null)
    .is('closed_at', null)
    .order('id')
    .limit(BATCH_SIZE + inactiveIds.size);
  if (fetchError) { console.error('[backfill-google-places] could not fetch venues', fetchError); return; }
  const venues = (rawVenues ?? []).filter((v) => !inactiveIds.has(v.id as string)).slice(0, BATCH_SIZE) as (RatingVenue & { image_url: string | null })[];
  if (venues.length === 0) { console.log('[backfill-google-places] no venues left with missing google_place_id — Rückstand abgearbeitet 🎉'); return; }

  let matched = 0, notFound = 0, photosDownloaded = 0, enterpriseCalls = 0;
  let i = 0;
  for (const venue of venues) {
    i++;
    console.log(`[backfill-google-places] (${i}/${venues.length}) ${venue.name}`);
    try {
      const { candidate } = await resolvePlaceCandidateWithFallback(apiKey, venue);
      if (!candidate) {
        notFound++;
        await supabase.from('venues').update({ google_rating_checked_at: new Date().toISOString(), google_not_found_streak: 0 }).eq('id', venue.id);
        const { error: queueError } = await supabase.rpc('submit_venue_closure_report', { p_venue_id: venue.id });
        if (queueError) console.warn(`[backfill-google-places] could not queue "${venue.name}"`, queueError.message);
        continue;
      }

      enterpriseCalls++;
      const details = await fetchDetailsWithPhotos(apiKey, candidate.id);
      matched++;
      const update: Record<string, unknown> = {
        google_place_id: candidate.id,
        google_rating: details?.rating ?? null,
        google_rating_count: details?.count ?? null,
        google_business_status: details?.businessStatus ?? null,
        google_opening_hours: details?.openingHours ?? null,
        google_rating_checked_at: new Date().toISOString(),
        google_opening_hours_checked_at: new Date().toISOString(),
        google_not_found_streak: 0,
      };
      if (details?.displayName) update.name_override = details.displayName;
      if (!venue.website && details?.website) update.website = details.website;
      if (!venue.phone && details?.phone) update.phone = details.phone;

      // Foto nur beschaffen, wenn die Venue noch keins hat (kein
      // Ueberschreiben bestehender, ggf. besserer Website-Bilder) UND noch
      // Foto-Budget uebrig ist.
      if (!venue.image_url && details?.photoName && photoBudgetRemaining > 0) {
        const bytes = await fetchGooglePhotoBytes(apiKey, details.photoName);
        if (bytes) {
          const objectPath = `${venue.id}.jpg`;
          const { error: uploadError } = await supabase.storage
            .from(VENUE_PHOTOS_BUCKET)
            .upload(objectPath, bytes, { contentType: 'image/jpeg', upsert: true });
          if (uploadError) {
            console.warn(`[backfill-google-places] photo upload failed for "${venue.name}"`, uploadError.message);
          } else {
            const { data: pub } = supabase.storage.from(VENUE_PHOTOS_BUCKET).getPublicUrl(objectPath);
            update.image_url = pub.publicUrl;
            photosDownloaded++;
            photoBudgetRemaining--;
          }
        }
      }

      await supabase.from('venues').update(update).eq('id', venue.id);

      if (details?.businessStatus === 'CLOSED_PERMANENTLY') {
        const { data: existing } = await supabase.from('venue_closure_reports').select('status').eq('venue_id', venue.id).maybeSingle();
        const { error: queueError } = await supabase.rpc('submit_venue_closure_report', { p_venue_id: venue.id });
        if (!queueError && existing?.status !== 'rejected') {
          await supabase
            .from('venue_closure_reports')
            .update({ status: 'confirmed', review_note: 'Automatisch bestätigt (einmaliger Backfill-Sweep): Google Places zeigt CLOSED_PERMANENTLY.' })
            .eq('venue_id', venue.id)
            .eq('status', 'pending');
        }
      }
    } catch (err) {
      console.warn(`[backfill-google-places] error processing "${venue.name}"`, err);
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  // Grobe Kostenschätzung dieses Laufs (nur für Transparenz im Log, keine
  // echte Abrechnungsabfrage — die gibt es ohne GCP-Billing-API-Zugriff
  // hier nicht). Erste 1.000 Enterprise-Details bzw. Fotos pro Monat sind
  // separat kostenlos; wie viel davon in DIESEM Lauf schon verbraucht war,
  // kennt dieses Skript nicht — daher konservativ als Vollpreis geschätzt.
  const estimatedCostEur = enterpriseCalls * 0.02 + photosDownloaded * 0.007;
  console.log(
    `[backfill-google-places] done — ${matched} matched (${enterpriseCalls} Enterprise-Detail-Calls), ${notFound} not found, ` +
    `${photosDownloaded} Fotos heruntergeladen/gehostet. Grobe Kostenschätzung dieses Laufs (Vollpreis, ohne evtl. Freikontingent): ~${estimatedCostEur.toFixed(2)}€`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}

export default run;
