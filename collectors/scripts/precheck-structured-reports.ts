import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  fetchDetails,
  looksLikeSameVenue,
  resolvePlaceCandidateByWebsiteTitle,
  resolvePlaceCandidateWithFallback,
  type PlaceCandidate,
  type RatingVenue,
} from '../sources/google-ratings/index.js';
import { fetchPageTitle, probePublicUrl, type UrlProbe } from '../core/urlProbe.js';
import { probeVenueOnOsm } from '../core/osmProbe.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../app/.env') });

type ClosureReport = { venue_id: string; analysis_attempts: number };
type VenueReport = { id: string; venue_id: string; reason: string | null; note: string | null; analysis_attempts: number };

async function audit(
  supabase: SupabaseClient,
  provider: string,
  operation: string,
  reportKind: string,
  reportId: string,
  outcome: string,
  evidence: unknown
) {
  const { error } = await supabase.from('automation_audit_log').insert({
    provider,
    operation,
    report_kind: reportKind,
    report_id: reportId,
    outcome,
    evidence,
  });
  if (error) console.warn('[precheck-structured] Audit-Log fehlgeschlagen', error.message);
}

async function updateAnalysis(
  supabase: SupabaseClient,
  table: string,
  idColumn: string,
  id: string,
  values: Record<string, unknown>
) {
  const { error } = await supabase.from(table).update({
    analyzed_at: new Date().toISOString(),
    analysis_error: null,
    ...values,
  }).eq(idColumn, id);
  if (error) throw error;
}

async function precheckClosures(supabase: SupabaseClient, apiKey: string | undefined) {
  if (!apiKey) { console.log('[precheck-structured] kein Google-Key — Schliessungspruefung bleibt offen'); return; }
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
  const { count } = await supabase
    .from('automation_audit_log')
    .select('id', { count: 'exact', head: true })
    .eq('provider', 'google_places')
    .gte('created_at', monthStart);
  const remaining = Math.max(0, Number(process.env.FEEDBACK_GOOGLE_MONTHLY_LIMIT ?? 50) - (count ?? 0));
  if (!remaining) { console.log('[precheck-structured] Google-Pruefbudget fuer diesen Monat erschoepft'); return; }

  const { data, error } = await supabase
    .from('venue_closure_reports')
    .select('venue_id,analysis_attempts')
    .eq('status', 'pending')
    .in('analysis_status', ['pending', 'failed'])
    .lt('analysis_attempts', 3)
    .order('reported_at')
    .limit(remaining);
  if (error) throw error;
  const reports = (data ?? []) as ClosureReport[];
  if (!reports.length) return;
  const { data: venues, error: venueError } = await supabase
    .from('venues')
    .select('id,name,address,latitude,longitude,website,phone,google_place_id,google_not_found_streak')
    .in('id', reports.map((row) => row.venue_id));
  if (venueError) throw venueError;
  const venueById = new Map((venues ?? []).map((venue) => [venue.id, venue as RatingVenue]));

  for (const report of reports) {
    const venue = venueById.get(report.venue_id);
    if (!venue) continue;
    const attempt = report.analysis_attempts + 1;
    await updateAnalysis(supabase, 'venue_closure_reports', 'venue_id', report.venue_id, { analysis_status: 'processing', analysis_attempts: attempt });
    try {
      let candidate: PlaceCandidate | null = venue.google_place_id
        ? { id: venue.google_place_id, name: venue.name, address: venue.address }
        : (await resolvePlaceCandidateWithFallback(apiKey, venue)).candidate;
      let matched = Boolean(candidate) && (Boolean(venue.google_place_id) || looksLikeSameVenue(venue, candidate!));
      let usedWebsiteNameFallback = false;

      const websiteProbe = venue.website ? await probePublicUrl(venue.website) : null;

      // Dritter Versuch: Name+Adresse-Suche (inkl. Fallback ohne Adresse)
      // findet nichts, aber die Venue hat eine erreichbare eigene Website —
      // deren Seitentitel enthaelt oft den echten Geschaeftsnamen, wo unser
      // (meist von OSM uebernommener) Name nur eine generische Kategorie ist
      // (z.B. "Schreib- und Tabakwaren" statt "Schreibwaren BAL"). Genau der
      // Schritt, der bei manueller Pruefung ("kurz googeln") sofort zum
      // Treffer fuehrt. Siehe resolvePlaceCandidateByWebsiteTitle().
      if (!matched && venue.website && websiteProbe?.outcome === 'reachable') {
        const { title } = await fetchPageTitle(venue.website);
        if (title) {
          const viaTitle = await resolvePlaceCandidateByWebsiteTitle(apiKey, venue, title);
          if (viaTitle) {
            candidate = viaTitle;
            matched = true;
            usedWebsiteNameFallback = true;
          }
        }
      }

      const details = matched && candidate ? await fetchDetails(apiKey, candidate.id) : null;
      // Zweites, von Google unabhaengiges Signal nur einholen, wenn Google
      // (auch nach dem Website-Namen-Fallback) weiterhin "kein Treffer" sagt
      // und eine hinterlegte Website (falls vorhanden) ebenfalls nicht mehr
      // erreichbar ist — sonst unnoetiger Nominatim-Traffic fuer Faelle, die
      // ohnehin schon anders entschieden werden.
      const noGoogleMatch = !matched;
      const websiteGoneOrAbsent = !venue.website || websiteProbe?.outcome === 'gone';
      const osmProbe = noGoogleMatch && websiteGoneOrAbsent ? await probeVenueOnOsm(venue.name, venue.address) : null;
      // Fuer den Fall "Google findet's trotz Website-Namen-Fallback nicht,
      // aber OSM UND die eigene Website bestaetigen unabhaengig voneinander
      // laufenden Betrieb" separat pruefen (auch wenn websiteGoneOrAbsent
      // false ist, also der obige osmProbe nicht ausgeloest wurde).
      const osmProbeForReject = noGoogleMatch && !osmProbe && websiteProbe?.outcome === 'reachable'
        ? await probeVenueOnOsm(venue.name, venue.address)
        : osmProbe;
      const evidence = [{
        provider: 'google_places',
        matched: Boolean(matched),
        place_id: matched && candidate ? candidate.id : null,
        business_status: details?.businessStatus ?? null,
        ...(usedWebsiteNameFallback ? { via: 'website_title' } : {}),
      }, ...(websiteProbe ? [{ provider: 'official_website', ...websiteProbe }] : []),
        ...(osmProbeForReject ? [{ provider: 'osm_nominatim', ...osmProbeForReject }] : [])];

      if (matched && candidate) {
        await supabase.from('venues').update({
          google_place_id: candidate.id,
          ...(details?.displayName ? { name_override: details.displayName } : {}),
          google_business_status: details?.businessStatus ?? null,
          google_rating_checked_at: new Date().toISOString(),
        }).eq('id', venue.id);
      }

      if (details?.businessStatus === 'CLOSED_PERMANENTLY') {
        await updateAnalysis(supabase, 'venue_closure_reports', 'venue_id', report.venue_id, {
          status: 'confirmed',
          review_note: 'Automatisch bestaetigt: eindeutig zugeordneter Google-Places-Eintrag ist dauerhaft geschlossen.',
          analysis_status: 'auto_resolved',
          analysis_category: 'venue_closure',
          analysis_summary: 'Google Places meldet die eindeutig zugeordnete Location als dauerhaft geschlossen.',
          analysis_confidence: 1,
          analysis_evidence: evidence,
        });
        await audit(supabase, 'google_places', 'closure_verification', 'venue_closure_reports', report.venue_id, 'confirmed', evidence);
      } else if (matched && details?.businessStatus === 'OPERATIONAL') {
        // Symmetrisch zum CLOSED_PERMANENTLY-Fall oben: ein eindeutig
        // zugeordneter, als aktiv gemeldeter Google-Places-Eintrag ist
        // ebenso ein Auto-Entscheid wert — bisher blieb genau das trotz
        // eindeutiger Evidenz auf "manual_review" haengen, weil ein Nicht-
        // Treffer beim urspruenglichen (oft generischen) Namen nie mit dem
        // Website-Namen-Fallback nachgebessert wurde.
        await updateAnalysis(supabase, 'venue_closure_reports', 'venue_id', report.venue_id, {
          status: 'rejected',
          review_note: usedWebsiteNameFallback
            ? 'Automatisch abgelehnt: ueber den Seitentitel der hinterlegten Website als aktiver Google-Places-Eintrag zugeordnet (Existenzbeleg, kein Uebereinstimmungs-Risiko dank Adressabgleich).'
            : 'Automatisch abgelehnt: eindeutig zugeordneter Google-Places-Eintrag ist aktiv.',
          analysis_status: 'auto_resolved',
          analysis_category: 'venue_closure',
          analysis_summary: 'Google Places meldet die eindeutig zugeordnete Location als aktiv (OPERATIONAL).',
          analysis_confidence: usedWebsiteNameFallback ? 0.85 : 0.95,
          analysis_evidence: evidence,
        });
        await audit(supabase, 'google_places', 'closure_verification', 'venue_closure_reports', report.venue_id, 'rejected', evidence);
      } else if (noGoogleMatch && websiteProbe?.outcome === 'reachable' && osmProbeForReject?.outcome === 'found') {
        // Google findet auch mit Website-Namen-Fallback nichts, aber zwei
        // andere unabhaengige Quellen (eigene Website erreichbar + OSM/
        // Nominatim kennt die Adresse) bestaetigen uebereinstimmend
        // laufenden Betrieb — genau die Beleglage, die zuvor mehrfach
        // manuell per "existiert noch"-Ablehnung entschieden wurde (BAL,
        // Schreibwaren, M.C. Mueller, Hey Luigi, ...).
        await updateAnalysis(supabase, 'venue_closure_reports', 'venue_id', report.venue_id, {
          status: 'rejected',
          review_note: 'Automatisch abgelehnt: kein Google-Places-Treffer, aber eigene Website erreichbar und OpenStreetMap/Nominatim bestaetigt die Adresse unabhaengig.',
          analysis_status: 'auto_resolved',
          analysis_category: 'venue_closure',
          analysis_summary: 'Zwei von Google unabhaengige Quellen (eigene Website, OpenStreetMap) bestaetigen laufenden Betrieb.',
          analysis_confidence: 0.8,
          analysis_evidence: evidence,
        });
        await audit(supabase, 'website+osm', 'closure_verification_heuristic', 'venue_closure_reports', report.venue_id, 'rejected_heuristic', evidence);
      } else if (osmProbe?.outcome === 'not_found') {
        // Heuristik: zwei unabhaengige Quellen (Google Places, OSM/Nominatim)
        // finden die Location nicht UND eine hinterlegte Website ist tot oder
        // fehlt. Anders als der 2026 abgeschaffte "3x Google-Nichttreffer"-
        // Mechanismus (0033_weekly_manual_review.sql) ist das keine Wieder-
        // holung derselben Quelle, sondern echte unabhaengige Evidenz — aber
        // immer noch kein Vollbeweis (kleine Lokale fehlen auch bei OSM oft
        // schon im Normalbetrieb), daher bewusst niedrigere Konfidenz als der
        // eindeutige Google-CLOSED_PERMANENTLY-Fall oben.
        await updateAnalysis(supabase, 'venue_closure_reports', 'venue_id', report.venue_id, {
          status: 'confirmed',
          review_note: `Automatisch bestaetigt (Heuristik): weder bei Google Places noch bei OpenStreetMap/Nominatim auffindbar${venue.website ? '; hinterlegte Website nicht mehr erreichbar' : '; keine Website hinterlegt'}.`,
          analysis_status: 'auto_resolved',
          analysis_category: 'venue_closure_heuristic',
          analysis_summary: `Zwei unabhaengige Quellen (Google Places, OpenStreetMap) finden die Location nicht${venue.website ? '; hinterlegte Website ist ebenfalls nicht erreichbar.' : '.'}`,
          analysis_confidence: 0.75,
          analysis_evidence: evidence,
        });
        await audit(supabase, 'google_places+osm', 'closure_verification_heuristic', 'venue_closure_reports', report.venue_id, 'confirmed_heuristic', evidence);
      } else {
        await updateAnalysis(supabase, 'venue_closure_reports', 'venue_id', report.venue_id, {
          analysis_status: 'manual_review',
          analysis_category: 'venue_closure',
          analysis_summary: matched
            ? `Google-Status ${details?.businessStatus ?? 'unklar'}; keine eindeutige automatische Entscheidung.`
            : 'Kein sicher zuordenbarer Google-Places-Eintrag gefunden; Nichtfund ist kein Schliessungsbeleg.',
          analysis_confidence: details?.businessStatus === 'OPERATIONAL' && websiteProbe?.outcome === 'reachable' ? 0.9 : matched ? 0.7 : 0,
          analysis_evidence: evidence,
        });
        await audit(supabase, 'google_places', 'closure_verification', 'venue_closure_reports', report.venue_id, 'manual_review', evidence);
      }
    } catch (checkError) {
      const message = checkError instanceof Error ? checkError.message : String(checkError);
      await updateAnalysis(supabase, 'venue_closure_reports', 'venue_id', report.venue_id, {
        analysis_status: attempt >= 3 ? 'manual_review' : 'failed', analysis_error: message.slice(0, 1000),
      });
      await audit(supabase, 'google_places', 'closure_verification', 'venue_closure_reports', report.venue_id, 'failed', { error: message.slice(0, 500) });
    }
  }
}

function reportMentionsWebsite(report: VenueReport): boolean {
  return /website|webseite|homepage|link/i.test(`${report.reason ?? ''} ${report.note ?? ''}`);
}

async function precheckVenueReports(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('venue_reports')
    .select('id,venue_id,reason,note,analysis_attempts')
    .eq('status', 'pending')
    .in('analysis_status', ['pending', 'failed'])
    .lt('analysis_attempts', 3)
    .order('created_at')
    .limit(100);
  if (error) throw error;
  const reports = (data ?? []) as VenueReport[];
  if (!reports.length) return;
  const { data: venues, error: venueError } = await supabase
    .from('venues')
    .select('id,name,website,beer_price_eur')
    .in('id', [...new Set(reports.map((row) => row.venue_id))]);
  if (venueError) throw venueError;
  const venueById = new Map((venues ?? []).map((venue) => [venue.id, venue]));

  for (const report of reports) {
    const venue = venueById.get(report.venue_id);
    const attempt = report.analysis_attempts + 1;
    await updateAnalysis(supabase, 'venue_reports', 'id', report.id, { analysis_status: 'processing', analysis_attempts: attempt });
    try {
      let probe: UrlProbe | null = null;
      if (venue?.website && reportMentionsWebsite(report)) probe = await probePublicUrl(venue.website);
      if (venue?.website && probe?.outcome === 'gone') {
        const { error: venueUpdateError } = await supabase.from('venues').update({ website: null }).eq('id', venue.id).eq('website', venue.website);
        if (venueUpdateError) throw venueUpdateError;
        const evidence = [{ provider: 'direct_url_check', ...probe }];
        await updateAnalysis(supabase, 'venue_reports', 'id', report.id, {
          status: 'resolved',
          review_note: `Automatisch umgesetzt: hinterlegte Website ist eindeutig nicht mehr vorhanden (${probe.reason}).`,
          analysis_status: 'auto_resolved',
          analysis_category: 'broken_link',
          analysis_summary: 'Die nicht mehr vorhandene Website wurde entfernt.',
          analysis_confidence: 1,
          analysis_evidence: evidence,
        });
        await audit(supabase, 'direct_http', 'website_verification', 'venue_reports', report.id, 'website_removed', evidence);
      } else {
        const beerMatch = `${report.note ?? ''}`.match(/\b(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:€|eur)\b/i);
        const evidence = probe ? [{ provider: 'direct_url_check', ...probe }] : [];
        await updateAnalysis(supabase, 'venue_reports', 'id', report.id, {
          analysis_status: 'manual_review',
          analysis_category: beerMatch ? 'beer_price' : reportMentionsWebsite(report) ? 'broken_link' : 'data_error',
          analysis_summary: beerMatch
            ? `Gemeldeter Bierpreis ${beerMatch[1].replace(',', '.')} EUR ist strukturiert, aber ohne unabhaengige Preisquelle nicht verifiziert.`
            : probe
              ? `Website-Pruefung: ${probe.reason}; keine eindeutige automatische Aenderung.`
              : 'Fuer diese Datenmeldung fehlt eine eindeutige maschinell pruefbare Quelle.',
          analysis_confidence: beerMatch || probe ? 0.8 : 0.3,
          analysis_evidence: evidence,
        });
      }
    } catch (checkError) {
      const message = checkError instanceof Error ? checkError.message : String(checkError);
      await updateAnalysis(supabase, 'venue_reports', 'id', report.id, {
        analysis_status: attempt >= 3 ? 'manual_review' : 'failed', analysis_error: message.slice(0, 1000),
      });
    }
  }
}

export async function run() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) throw new Error('Supabase-Umgebung fehlt');
  const supabase = createClient(supabaseUrl, supabaseKey);
  await precheckClosures(supabase, process.env.GOOGLE_PLACES_API_KEY);
  await precheckVenueReports(supabase);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
}
