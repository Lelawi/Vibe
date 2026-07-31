import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { getCoordinates } from '../../core/geocode';
import { buildStableSourceId, dedupeBySourceId } from '../../core/scrape';

// Wannda betreibt kein JS-Frontend, sondern klassisches WordPress mit
// öffentlicher REST-API (wp-json/wp/v2/posts) — jedes Event ist ein eigener
// Post. Anders als bei den meisten anderen Quellen steckt der Titel NICHT im
// normalen post_content (bei diesem Page-Builder-Theme leer), sondern in
// zwei <h5>-Tags innerhalb von title.rendered ("<Tag>.<Monat>" + Eventname)
// — und die einzige Stelle mit einem VOLLSTÄNDIGEN, eindeutigen Datum (inkl.
// Jahr) ist "div.desc h2" auf der jeweiligen Event-Detailseite, z.B.
// "Sa. 01. August 2026 | 12.00 Uhr" oder als Datumsspanne ohne Uhrzeit
// "26. - 27. Juni 2027" (per Direktabruf gegen 4 verschiedene Event-Posts
// verifiziert, 2026-07 — u.a. wichtig, weil die WordPress-"date"/"modified"-
// Felder selbst NICHT das tatsächliche Eventdatum sind, sondern nur wann der
// Post zuletzt bearbeitet wurde). Deshalb: erst die Liste aller Posts holen,
// dann pro Post die Detailseite für das echte Datum/Uhrzeit nachladen.
const WANNDA_API = 'https://wannda.de/wp-json/wp/v2/posts?per_page=100&_fields=id,slug,link,title';
const WANNDA_ADDRESS = 'Völckerstraße 5, 80939 München';
const WANNDA_LOCATION = 'Wannda Circus Freimann';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const GERMAN_MONTHS: Record<string, number> = {
  januar: 1, februar: 2, märz: 3, april: 4, mai: 5, juni: 6, juli: 7,
  august: 8, september: 9, oktober: 10, november: 11, dezember: 12,
};

// Deckt sowohl "Sa. 01. August 2026 | 12.00 Uhr" (Einzeltag + Uhrzeit,
// Wochentagspräfix mit/ohne Leerzeichen davor) als auch "26. - 27. Juni
// 2027" (Datumsspanne, keine Uhrzeit) ab. Der optionale Spannen-Teil greift
// nur, wenn direkt ein "- <Tag>." folgt — sonst bleibt es bei einem
// einzelnen Tag.
const DESC_DATE = /(\d{1,2})\.\s*(?:-\s*(\d{1,2})\.\s*)?([A-Za-zäöüÄÖÜ]+)\s*(\d{4})(?:\s*\|\s*(\d{1,2})\.(\d{2})\s*Uhr)?/;

function toIsoDate(day: number, month: number, year: number): string | null {
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return isNaN(candidate.getTime()) ? null : candidate.toISOString().slice(0, 10);
}

function parseDescDate(text: string): { date: string; endDate: string | null; time: string | null } | null {
  const m = text.match(DESC_DATE);
  if (!m) return null;
  const month = GERMAN_MONTHS[m[3].toLowerCase()];
  if (!month) return null;
  const year = parseInt(m[4], 10);
  const date = toIsoDate(parseInt(m[1], 10), month, year);
  if (!date) return null;
  const endDate = m[2] ? toIsoDate(parseInt(m[2], 10), month, year) : null;
  const time = m[5] && m[6] ? `${m[5].padStart(2, '0')}:${m[6]}` : null;
  return { date, endDate, time };
}

type WpPost = { id: number; slug: string; link: string; title: { rendered: string } };

export async function run() {
  console.log('[wannda] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[wannda] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const today = new Date().toISOString().slice(0, 10);
  const collected: any[] = [];
  const coords = await getCoordinates(supabase, WANNDA_LOCATION, WANNDA_ADDRESS, 'München');

  try {
    console.log('[wannda] fetching post list');
    const listRes = await fetch(WANNDA_API, { headers: { 'User-Agent': USER_AGENT } });
    if (!listRes.ok) { console.warn('[wannda] list fetch failed', listRes.status); return; }
    const posts = (await listRes.json()) as WpPost[];
    console.log('[wannda]', posts.length, 'posts found');

    for (const post of posts) {
      const $title = cheerio.load(post.title.rendered);
      const h5s = $title('h5');
      const name = (h5s.length > 1 ? h5s.last() : h5s.first()).text().trim();
      if (!name) continue;

      let detailHtml: string;
      try {
        const detailRes = await fetch(post.link, { headers: { 'User-Agent': USER_AGENT } });
        if (!detailRes.ok) { console.warn('[wannda] detail fetch failed', post.link, detailRes.status); continue; }
        detailHtml = await detailRes.text();
      } catch (err) {
        console.warn('[wannda] detail fetch error', post.link, err);
        continue;
      } finally {
        // Eigener, unproblematischer Host (keine anderen Collector teilen ihn)
        // — trotzdem kurze Pause zwischen den 17 Detail-Abrufen, aus reiner
        // Höflichkeit gegenüber einem kleinen Vereins-Server.
        await new Promise((r) => setTimeout(r, 500));
      }

      const $ = cheerio.load(detailHtml);
      const descText = $('div.desc h2').first().text().replace(/\s+/g, ' ').trim();
      const parsed = parseDescDate(descText);
      if (!parsed) { console.warn('[wannda] could not parse date for', post.link, JSON.stringify(descText)); continue; }
      // Bei Datumsspannen (z.B. "26. - 27. Juni 2027") hält end_date das
      // Event bis zum letzten Tag sichtbar (siehe Query-Filter in
      // app/app/index.tsx: start_date >= today OR end_date >= today).
      if (parsed.endDate ? parsed.endDate < today : parsed.date < today) continue;

      const sourceId = buildStableSourceId('wannda', post.link, parsed.date);
      collected.push({
        source_id: sourceId,
        title: name,
        description: null,
        category: 'Kultur',
        subcategory: null,
        start_date: parsed.date,
        end_date: parsed.endDate,
        start_time: parsed.time,
        location_name: WANNDA_LOCATION,
        address: WANNDA_ADDRESS,
        city: 'München',
        organizer: 'Wannda',
        source_url: post.link,
        image_url: null,
        price_info: null,
        latitude: coords?.latitude ?? null,
        longitude: coords?.longitude ?? null,
      });
    }
  } catch (err) {
    console.warn('[wannda] error', err);
  }

  if (collected.length === 0) { console.log('[wannda] no events parsed'); return; }
  console.log('[wannda] upserting', collected.length, 'events');
  const { error } = await supabase.from('events').upsert(dedupeBySourceId(collected), { onConflict: 'source_id' });
  if (error) console.error('[wannda] upsert error', error);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

export default run;
