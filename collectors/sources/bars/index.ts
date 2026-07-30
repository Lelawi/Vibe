import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';
import { fileURLToPath } from 'url';

// OpenStreetMap/Overpass statt eines Ticketing-Collectors: eine Bar ist ein
// Ort mit regulären Öffnungszeiten, kein einzelner Termin, und dafür gibt es
// bei den bisherigen Quellen keine Entsprechung. Overpass ist kostenlos,
// braucht keinen API-Key, und München ist gut gepflegt: 585 amenity=bar/pub-
// Knoten gefunden, davon ~67% mit einem opening_hours-Tag (per Direktabruf
// verifiziert, 2026-07).
const OVERPASS_URL = 'https://overpass.kumi.systems/api/interpreter';
// Bounding Box um München (Stadtgebiet + etwas Umland) statt Namens-Lookup
// (area["name"="München"]["admin_level"=...] ist je nach OSM-Relation
// fehleranfällig — lieferte beim Direktabruf 406 statt Daten).
const MUNICH_BBOX = '48.0616,11.3600,48.2482,11.7228';
const OVERPASS_QUERY = `
[out:json][timeout:25];
(
  node["amenity"="bar"](${MUNICH_BBOX});
  node["amenity"="pub"](${MUNICH_BBOX});
);
out body;
`;

interface OverpassElement {
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

function buildAddress(tags: Record<string, string>): string | null {
  const streetLine = [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ');
  const cityLine = [tags['addr:postcode'], tags['addr:city']].filter(Boolean).join(' ');
  const parts = [streetLine, cityLine].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

// OSM-opening_hours-Tags sind gelegentlich ungenau/veraltet (per Nutzer-
// Stichprobe verifiziert, 2026-07: Alter Simpl steht in OSM mit "Mo-We
// 11:00-00:00...", das tatsächliche Türschild sagt "Mo-Mi 11:30-00:00...").
// Viele Bar-Websites veröffentlichen dagegen eigene, vom Betreiber
// gepflegte schema.org-Öffnungszeiten (für Google-Suchergebnis-Snippets) —
// als "openingHours"-String(-array) im selben Tagesformat wie OSM (Mo/Tu/
// We/...), oder als "openingHoursSpecification"-Objekte mit dayOfWeek/
// opens/closes. Wo vorhanden, ist das zuverlässiger als der OSM-Tag und
// wird als opening_hours_override gespeichert (nimmt in der App Vorrang
// vor opening_hours_raw, siehe app/lib/openingHours.ts-Aufrufer).
const DAY_ABBR: Record<string, string> = {
  Monday: 'Mo', Tuesday: 'Tu', Wednesday: 'We', Thursday: 'Th', Friday: 'Fr', Saturday: 'Sa', Sunday: 'Su',
};
const DAY_ORDER = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

function dayNameToAbbr(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.split('/').pop() ?? value;
  return DAY_ABBR[name] ?? null;
}

// Fasst Tage mit identischer Öffnungszeit zu Bereichen zusammen (z.B. [Mo,Tu,We]
// -> "Mo-We"), damit der bestehende OSM-Syntax-Parser (app/lib/openingHours.ts)
// das Ergebnis direkt versteht — der unterstützt TagesBEREICHE, aber keine
// Kommalisten mit geteilter Zeit für mehr als einen Tag.
function dayRunsToTokens(days: string[]): string[] {
  const indices = [...new Set(days.map((d) => DAY_ORDER.indexOf(d)).filter((i) => i >= 0))].sort((a, b) => a - b);
  const tokens: string[] = [];
  let i = 0;
  while (i < indices.length) {
    let j = i;
    while (j + 1 < indices.length && indices[j + 1] === indices[j] + 1) j++;
    tokens.push(i === j ? DAY_ORDER[indices[i]] : `${DAY_ORDER[indices[i]]}-${DAY_ORDER[indices[j]]}`);
    i = j + 1;
  }
  return tokens;
}

function normalizeTime(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

// Manche Websites veröffentlichen unvollständiges/kaputtes schema.org-Markup
// (per Direktabruf verifiziert, 2026-07: alter-simpl.de liefert
// "dayOfWeek": ["Monday","Sunday"], 09:00-01:00 — offensichtlich ein
// Templating-Artefakt, keine echten Öffnungszeiten für nur 2 von 7 Tagen,
// während die Tür laut Aushang an allen 7 Tagen öffnet). Ein Override, der
// weniger als 5 Wochentage abdeckt, ist unglaubwürdiger als selbst ein
// ungenauer OSM-Tag und wird verworfen statt übernommen.
const MIN_COVERED_DAYS = 5;

function countCoveredDays(hoursStr: string): number {
  const covered = new Set<string>();
  const dayToken = /\b(Mo|Tu|We|Th|Fr|Sa|Su)(-(Mo|Tu|We|Th|Fr|Sa|Su))?\b/g;
  let m: RegExpExecArray | null;
  while ((m = dayToken.exec(hoursStr))) {
    if (m[3]) {
      const start = DAY_ORDER.indexOf(m[1]);
      const end = DAY_ORDER.indexOf(m[3]);
      if (start === -1 || end === -1) continue;
      let i = start;
      while (true) {
        covered.add(DAY_ORDER[i]);
        if (i === end) break;
        i = (i + 1) % DAY_ORDER.length;
      }
    } else {
      covered.add(m[1]);
    }
  }
  return covered.size;
}

function extractOpeningHoursOverride($: cheerio.CheerioAPI): string | null {
  for (const el of $('script[type="application/ld+json"]').toArray()) {
    let json: unknown;
    try {
      json = JSON.parse($(el).contents().text());
    } catch {
      continue;
    }
    const nodes = Array.isArray(json) ? json : [json, ...((json as any)?.['@graph'] ?? [])];
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const n = node as Record<string, unknown>;
      let candidate: string | null = null;

      if (typeof n.openingHours === 'string' && n.openingHours.trim()) {
        candidate = n.openingHours.trim();
      } else if (Array.isArray(n.openingHours) && n.openingHours.length) {
        const joined = n.openingHours.filter((v): v is string => typeof v === 'string').join('; ');
        if (joined) candidate = joined;
      } else if (n.openingHoursSpecification) {
        const specs = Array.isArray(n.openingHoursSpecification) ? n.openingHoursSpecification : [n.openingHoursSpecification];
        const groups = new Map<string, Set<string>>();
        for (const s of specs) {
          const opens = normalizeTime((s as any)?.opens);
          const closes = normalizeTime((s as any)?.closes);
          if (!opens || !closes) continue;
          const daysRaw = Array.isArray((s as any)?.dayOfWeek) ? (s as any).dayOfWeek : [(s as any)?.dayOfWeek];
          const abbrs = daysRaw.map(dayNameToAbbr).filter((d: string | null): d is string => !!d);
          if (!abbrs.length) continue;
          const key = `${opens}-${closes}`;
          if (!groups.has(key)) groups.set(key, new Set());
          abbrs.forEach((a: string) => groups.get(key)!.add(a));
        }
        if (groups.size > 0) {
          const blocks = [...groups.entries()].flatMap(([key, daySet]) => {
            const [opens, closes] = key.split('-');
            return dayRunsToTokens([...daySet]).map((token) => `${token} ${opens}-${closes}`);
          });
          if (blocks.length) candidate = blocks.join('; ');
        }
      }

      if (candidate && countCoveredDays(candidate) >= MIN_COVERED_DAYS) return candidate;
    }
  }
  return null;
}

// OSM selbst pflegt so gut wie nie ein "image"-Tag auf Bar-Knoten, aber viele
// Bars haben eine eigene Website mit og:image (dieselbe Quelle nutzen z.B.
// sources/auer_dult, sources/milla). Ein Abruf liefert best effort sowohl
// Bild als auch (falls vorhanden) die genaueren Öffnungszeiten mit — schlägt
// beides fehl, bleiben die Felder einfach null, keine Bar fällt deswegen aus
// dem Lauf raus.
async function fetchWebsiteEnrichment(website: string): Promise<{ image: string | null; hours: string | null }> {
  try {
    const res = await fetch(website, {
      headers: { 'User-Agent': 'VibeApp-Collector/1.0 (nicht-kommerziell, github.com/Lelawi/Vibe)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { image: null, hours: null };
    const html = await res.text();
    const imageMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    // Relative og:image-URLs (z.B. "/images/hero.jpg") kommen vor —
    // gegen die Website-URL auflösen statt kaputte relative Pfade zu speichern.
    const image = imageMatch ? new URL(imageMatch[1], website).toString() : null;
    const $ = cheerio.load(html);
    const hours = extractOpeningHoursOverride($);
    return { image, hours };
  } catch {
    return { image: null, hours: null };
  }
}

export async function run() {
  console.log('[bars] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[bars] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'User-Agent': 'VibeApp-Collector/1.0 (nicht-kommerziell, github.com/Lelawi/Vibe)',
      },
      body: 'data=' + encodeURIComponent(OVERPASS_QUERY),
    });
    if (!res.ok) { console.warn('[bars] overpass fetch failed', res.status); return; }

    const data = (await res.json()) as { elements: OverpassElement[] };
    const rawBars = data.elements
      .filter((el) => el.tags?.name)
      .map((el) => {
        const tags = el.tags!;
        return {
          osm_id: el.id,
          name: tags.name,
          address: buildAddress(tags),
          latitude: el.lat,
          longitude: el.lon,
          opening_hours_raw: tags.opening_hours ?? null,
          website: tags.website ?? tags['contact:website'] ?? null,
          phone: tags.phone ?? tags['contact:phone'] ?? null,
          updated_at: new Date().toISOString(),
        };
      });

    if (rawBars.length === 0) { console.log('[bars] no bars parsed'); return; }

    // Bereits vorhandene image_url/opening_hours_override je osm_id
    // wiederverwenden statt bei jedem (wöchentlichen) Lauf alle Websites
    // erneut abzuklappern — nur für Bars, denen noch mindestens eins von
    // beiden fehlt, wird neu gefetcht.
    const { data: existing } = await supabase.from('bars').select('osm_id,image_url,opening_hours_override');
    const existingByOsmId = new Map(
      (existing ?? []).map((b) => [b.osm_id as number, { image: b.image_url as string | null, hours: b.opening_hours_override as string | null }])
    );

    const toFetch = rawBars.filter((b) => {
      const cached = existingByOsmId.get(b.osm_id);
      return b.website && (!cached || !cached.image || !cached.hours);
    });
    console.log('[bars] fetching website enrichment for', toFetch.length, 'bars missing an image or opening-hours override');
    const enrichmentByOsmId = new Map<number, { image: string | null; hours: string | null }>();
    const CONCURRENCY = 6;
    let cursor = 0;
    async function worker() {
      while (cursor < toFetch.length) {
        const bar = toFetch[cursor++];
        enrichmentByOsmId.set(bar.osm_id, await fetchWebsiteEnrichment(bar.website!));
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    const bars = rawBars.map((b) => {
      const fetched = enrichmentByOsmId.get(b.osm_id);
      const cached = existingByOsmId.get(b.osm_id);
      return {
        ...b,
        image_url: fetched?.image ?? cached?.image ?? null,
        opening_hours_override: fetched?.hours ?? cached?.hours ?? null,
      };
    });

    console.log('[bars] upserting', bars.length, 'bars');
    const { error } = await supabase.from('bars').upsert(bars, { onConflict: 'osm_id' });
    if (error) console.error('[bars] upsert error', error);
  } catch (err) {
    console.warn('[bars] error', err);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}

export default run;
