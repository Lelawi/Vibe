import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';

// Gemeinsame Grundlage für Bars UND Restaurants (sources/bars,
// sources/restaurants): beide sind OSM/Overpass-basierte Orte mit regulären
// Öffnungszeiten statt Einzelterminen, geteilt über die generische
// venues-Tabelle (0015_venues_generalize_for_restaurants.sql) mit einer
// type-Spalte ('bar' | 'restaurant'). Extrahiert aus dem ursprünglichen
// Bars-Collector, damit Öffnungszeiten-Parsing, Bild-Scraping etc. nicht
// zweimal gepflegt werden müssen.
const OVERPASS_URL = 'https://overpass.kumi.systems/api/interpreter';
// Bounding Box um München (Stadtgebiet + etwas Umland) statt Namens-Lookup
// (area["name"="München"]["admin_level"=...] ist je nach OSM-Relation
// fehleranfällig — lieferte beim Direktabruf 406 statt Daten).
const MUNICH_BBOX = '48.0616,11.3600,48.2482,11.7228';

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
// Viele Venue-Websites veröffentlichen dagegen eigene, vom Betreiber
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

// Meta-Tags (og:image, twitter:image) sind der zuverlässigste Bild-Fund,
// aber per Stichprobe verifiziert (2026-07, 20 Restaurant-Websites mit
// Website aber ohne Bild): keine einzige kleine Gastro-Website pflegt
// Open-Graph-Tags. Fallback: die Bild-Tags der Seite selbst nach dem
// plausibelsten "echten" Foto durchsuchen (statt Logo/Icon/Social-Sprite/
// Cookie-Banner) — Heuristik über Dimensions-, Datei- und Keyword-Hinweise,
// an 17 realen Websites gegengetestet (14 klar richtig, 1 kein Fund, 2
// Grenzfälle akzeptiert) bevor sie hier scharf geschaltet wurde.
const NEGATIVE_IMG_HINTS = /logo|icon|sprite|avatar|pixel|badge|button|social|flag|payment|favicon|placeholder|platzhalter|dummy|spinner|loading|blank|arrow|star-|rating|cookie|gdpr|marker/i;
const POSITIVE_IMG_HINTS = /hero|header|banner|restaurant|food|interior|ambiente|slide|gallery|content|wp-content\/uploads|bild/i;

function scoreImgTag(tag: string): { src: string; score: number } | null {
  const srcMatch = tag.match(/\ssrc=["']([^"']+)["']/i);
  if (!srcMatch) return null;
  const src = srcMatch[1];
  if (src.startsWith('data:')) return null;
  if (/\.svg(\?|$)/i.test(src)) return null;

  let score = 0;
  const widthMatch = tag.match(/\swidth=["']?(\d+)/i);
  const heightMatch = tag.match(/\sheight=["']?(\d+)/i);
  const width = widthMatch ? Number(widthMatch[1]) : null;
  const height = heightMatch ? Number(heightMatch[1]) : null;
  if (width != null && width < 100) score -= 5;
  if (height != null && height < 100) score -= 5;
  if (width != null && width >= 400) score += 3;

  const altMatch = tag.match(/\salt=["']([^"']*)["']/i);
  const alt = altMatch ? altMatch[1] : '';
  const classMatch = tag.match(/\sclass=["']([^"']*)["']/i);
  const cls = classMatch ? classMatch[1] : '';

  const haystack = `${src} ${alt} ${cls}`;
  if (NEGATIVE_IMG_HINTS.test(haystack)) score -= 4;
  if (POSITIVE_IMG_HINTS.test(haystack)) score += 2;
  if (alt.trim().length > 3) score += 1;
  if (/\.(jpg|jpeg|png|webp)(\?|$)/i.test(src)) score += 1;
  if (/\.gif(\?|$)/i.test(src)) score -= 2;

  return { src, score };
}

function findBestImage(html: string, baseUrl: string): string | null {
  const imgTags = html.match(/<img\b[^>]*>/gi) ?? [];
  const candidates = imgTags.map(scoreImgTag).filter((c): c is { src: string; score: number } => c !== null);
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best) return null;
  try {
    return new URL(best.src, baseUrl).toString();
  } catch {
    return null;
  }
}

// Mittagskarten sind auf Restaurant-Websites nicht einheitlich verlinkt —
// mal ein eigener Menüpunkt/PDF-Link ("Mittagskarte", "Lunch Menu"), mal nur
// ein Satz im Fließtext ("Unser Mittagstisch: Mo-Fr 11:30-14:30"). Bewusst
// KEINE Google-Reviews/Kommentare als Quelle (dort erwähnen Gäste das oft
// auch) — dafür gäbe es keine freie, ToS-konforme API, nur Scraping von
// Google Maps, was hier nicht gemacht wird (siehe Store-Kommentar zu
// Bar-Bildern weiter oben im Projekt).
const LUNCH_KEYWORDS = /mittagskarte|mittagsmen[üu]|mittagstisch|lunch[\s-]?menu|lunchkarte|business[\s-]?lunch/i;

function extractLunchSignal($: cheerio.CheerioAPI, baseUrl: string): { available: boolean; menuUrl: string | null } {
  // Links zuerst prüfen: sowohl Linktext ("Mittagskarte") als auch die
  // URL selbst (z.B. eine PDF "speisekarte-mittags.pdf" ohne aussagekräftigen
  // Linktext) können den Hinweis tragen.
  let menuUrl: string | null = null;
  $('a[href]').each((_, el) => {
    if (menuUrl) return;
    const href = $(el).attr('href') ?? '';
    const text = $(el).text();
    if (LUNCH_KEYWORDS.test(href) || LUNCH_KEYWORDS.test(text)) {
      try {
        menuUrl = new URL(href, baseUrl).toString();
      } catch {
        menuUrl = null;
      }
    }
  });
  if (menuUrl) return { available: true, menuUrl };
  // Kein eigener Link/keine eigene Karte, aber der Begriff taucht im
  // Seitentext auf — schwächeres, aber immer noch brauchbares Signal ohne
  // verlinkbare Karte. $('body').text() allein reicht nicht: das zieht auch
  // <script>-Inhalte mit ein, und viele Websites betten Page-Builder-/
  // Analytics-JSON ein, das rein zufällig "Mittagstisch" als Teil eines
  // völlig unrelated Feldnamens enthält (per Direktabruf verifiziert,
  // 2026-07: mona-john.de bettet einen Reservierungs-Widget-Konfigblock mit
  // "location":{"name":"Mittagstisch - Coup de Coeur",...} ein — ein Konzert-
  // /Event-Name, keine Aussage über eigenes Mittagsangebot). Script/Style
  // vor der Textsuche entfernen, und einen kurzen Negations-Check davor
  // ("kein Mittagstisch") als zusätzliche Absicherung.
  const bodyClone = $('body').clone();
  bodyClone.find('script, style, noscript').remove();
  const bodyText = bodyClone.text();
  const match = LUNCH_KEYWORDS.exec(bodyText);
  if (match) {
    const precedingText = bodyText.slice(Math.max(0, match.index - 30), match.index);
    if (!/\b(kein|keine|nicht|ohne)\b/i.test(precedingText)) {
      return { available: true, menuUrl: null };
    }
  }
  return { available: false, menuUrl: null };
}

// OSM selbst pflegt so gut wie nie ein "image"-Tag, aber viele Venues haben
// eine eigene Website mit og:image (dieselbe Quelle nutzen z.B.
// sources/auer_dult, sources/milla). Ein Abruf liefert best effort Bild,
// (falls vorhanden) genauere Öffnungszeiten und einen Mittagslunch-Hinweis
// mit — schlägt alles fehl, bleiben die Felder einfach null/false, kein
// Venue fällt deswegen aus dem Lauf raus.
async function fetchWebsiteEnrichment(
  website: string
): Promise<{ image: string | null; hours: string | null; lunchAvailable: boolean; lunchMenuUrl: string | null }> {
  try {
    const res = await fetch(website, {
      headers: { 'User-Agent': 'VibeApp-Collector/1.0 (nicht-kommerziell, github.com/Lelawi/Vibe)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { image: null, hours: null, lunchAvailable: false, lunchMenuUrl: null };
    const html = await res.text();
    const metaMatch = html.match(/<meta[^>]+property=["'](?:og|twitter):image["'][^>]+content=["']([^"']+)["']/i)
      ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["'](?:og|twitter):image["']/i)
      ?? html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
      ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
    // Relative Bild-URLs (z.B. "/images/hero.jpg") kommen vor — gegen die
    // Website-URL auflösen statt kaputte relative Pfade zu speichern.
    const image = metaMatch ? new URL(metaMatch[1], website).toString() : findBestImage(html, website);
    const $ = cheerio.load(html);
    const hours = extractOpeningHoursOverride($);
    const lunch = extractLunchSignal($, website);
    return { image, hours, lunchAvailable: lunch.available, lunchMenuUrl: lunch.menuUrl };
  } catch {
    return { image: null, hours: null, lunchAvailable: false, lunchMenuUrl: null };
  }
}

export interface CollectVenuesOptions {
  label: string;
  type: 'bar' | 'restaurant';
  amenityValues: string[];
}

export async function collectVenues({ label, type, amenityValues }: CollectVenuesOptions): Promise<void> {
  console.log(`[${label}] starting`);
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log(`[${label}] missing supabase envs — skipping`); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  // amenity=restaurant hat in München deutlich mehr Treffer als bar/pub —
  // 25s reichte für Bars, für Restaurants kam wiederholt ein 504 vom
  // Overpass-Mirror zurück (per Direktabruf verifiziert, 2026-07).
  const overpassQuery = `
[out:json][timeout:60];
(
  ${amenityValues.map((a) => `node["amenity"="${a}"](${MUNICH_BBOX});`).join('\n  ')}
);
out body;
`;

  try {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'User-Agent': 'VibeApp-Collector/1.0 (nicht-kommerziell, github.com/Lelawi/Vibe)',
      },
      body: 'data=' + encodeURIComponent(overpassQuery),
    });
    if (!res.ok) { console.warn(`[${label}] overpass fetch failed`, res.status); return; }

    const data = (await res.json()) as { elements: OverpassElement[] };
    const rawVenues = data.elements
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
          // Nur bei Restaurants aussagekräftig (~80% Abdeckung, per
          // Direktabruf verifiziert, 2026-07) — bei Bars praktisch nie
          // gepflegt, aber unschädlich, das Feld trotzdem generisch
          // mitzunehmen.
          cuisine: tags.cuisine ?? null,
          type,
          updated_at: new Date().toISOString(),
        };
      });

    if (rawVenues.length === 0) { console.log(`[${label}] no venues parsed`); return; }

    // Bereits vorhandene image_url/opening_hours_override/lunch-Infos je
    // osm_id wiederverwenden statt bei jedem (wöchentlichen) Lauf alle
    // Websites erneut abzuklappern — nur für Venues, denen noch mindestens
    // eins davon fehlt, wird neu gefetcht.
    const { data: existing } = await supabase
      .from('venues')
      .select('osm_id,image_url,opening_hours_override,lunch_available,lunch_menu_url')
      .eq('type', type);
    const existingByOsmId = new Map(
      (existing ?? []).map((v) => [
        v.osm_id as number,
        {
          image: v.image_url as string | null,
          hours: v.opening_hours_override as string | null,
          lunchAvailable: (v.lunch_available as boolean | null) ?? false,
          lunchMenuUrl: v.lunch_menu_url as string | null,
        },
      ])
    );

    const toFetch = rawVenues.filter((v) => {
      const cached = existingByOsmId.get(v.osm_id);
      return v.website && (!cached || !cached.image || !cached.hours || !cached.lunchAvailable);
    });
    console.log(`[${label}] fetching website enrichment for`, toFetch.length, 'venues missing an image, opening-hours override or lunch info');
    const enrichmentByOsmId = new Map<
      number,
      { image: string | null; hours: string | null; lunchAvailable: boolean; lunchMenuUrl: string | null }
    >();
    const CONCURRENCY = 6;
    let cursor = 0;
    async function worker() {
      while (cursor < toFetch.length) {
        const venue = toFetch[cursor++];
        enrichmentByOsmId.set(venue.osm_id, await fetchWebsiteEnrichment(venue.website!));
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    const venues = rawVenues.map((v) => {
      const fetched = enrichmentByOsmId.get(v.osm_id);
      const cached = existingByOsmId.get(v.osm_id);
      return {
        ...v,
        image_url: fetched?.image ?? cached?.image ?? null,
        opening_hours_override: fetched?.hours ?? cached?.hours ?? null,
        lunch_available: fetched?.lunchAvailable ?? cached?.lunchAvailable ?? false,
        lunch_menu_url: fetched?.lunchMenuUrl ?? cached?.lunchMenuUrl ?? null,
      };
    });

    console.log(`[${label}] upserting`, venues.length, 'venues');
    const { error } = await supabase.from('venues').upsert(venues, { onConflict: 'osm_id' });
    if (error) console.error(`[${label}] upsert error`, error);
  } catch (err) {
    console.warn(`[${label}] error`, err);
  }
}
