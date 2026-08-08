import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchDetails, looksLikeSameVenue, resolvePlaceCandidateWithFallback, type RatingVenue } from '../sources/google-ratings/index.js';
import { probePublicUrl, type UrlProbe } from '../core/urlProbe.js';

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
      const candidate = venue.google_place_id
        ? { id: venue.google_place_id, name: venue.name, address: venue.address }
        : (await resolvePlaceCandidateWithFallback(apiKey, venue)).candidate;
      const matched = candidate && (venue.google_place_id || looksLikeSameVenue(venue, candidate));
      const details = matched ? await fetchDetails(apiKey, candidate.id) : null;
      const websiteProbe = venue.website ? await probePublicUrl(venue.website) : null;
      const evidence = [{
        provider: 'google_places',
        matched: Boolean(matched),
        place_id: matched ? candidate.id : null,
        business_status: details?.businessStatus ?? null,
      }, ...(websiteProbe ? [{ provider: 'official_website', ...websiteProbe }] : [])];

      if (matched) {
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
