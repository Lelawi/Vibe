import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';
// Deep-Import statt `import pdf from 'pdf-parse'`: das Paket-Root (index.js)
// prüft `module.parent`, um "als Bibliothek benutzt" vs. "direkt ausgeführt"
// zu unterscheiden — unter tsx/ESM ist module.parent immer undefined, das
// Paket denkt dann fälschlich, es liefe im Debug-Modus, und crasht beim
// Versuch, eine hartcodierte Test-PDF (test/data/05-versions-space.pdf) zu
// lesen, die hier nicht existiert. lib/pdf-parse.js ist die eigentliche
// Implementierung ohne diesen Check — ein bekannter, seit Jahren stabiler
// Workaround für dieses (unmaintained) Paket.
import pdf from 'pdf-parse/lib/pdf-parse.js';

// Gemeinsame Grundlage für Bars, Restaurants UND Spätis (sources/bars,
// sources/restaurants, sources/spaetis): alle drei sind OSM/Overpass-
// basierte Orte mit regulären Öffnungszeiten statt Einzelterminen, geteilt
// über die generische venues-Tabelle (0015_venues_generalize_for_
// restaurants.sql, 0019_venues_spaeti_type.sql) mit einer type-Spalte
// ('bar' | 'restaurant' | 'spaeti'). Extrahiert aus dem ursprünglichen
// Bars-Collector, damit Öffnungszeiten-Parsing, Bild-Scraping etc. nicht
// mehrfach gepflegt werden müssen.
const OVERPASS_URL = 'https://overpass.kumi.systems/api/interpreter';
// Bounding Box um München (Stadtgebiet + etwas Umland) statt Namens-Lookup
// (area["name"="München"]["admin_level"=...] ist je nach OSM-Relation
// fehleranfällig — lieferte beim Direktabruf 406 statt Daten).
const MUNICH_BBOX = '48.0616,11.3600,48.2482,11.7228';

// Einzelne OSM-Knoten, die zwar technisch amenity=restaurant/bar getaggt
// sind, aber keine öffentlich zugänglichen Gaststätten im Sinne der App
// sind — bewusst eine enge, von Hand kuratierte Liste statt eines
// Namensmuster-Filters (z.B. "Sportlerheim"/"Vereinsheim" im Namen), weil
// nicht jeder Treffer mit so einem Wort automatisch ein reiner Vereinsraum
// ist ("Auszeit im Vereinsheim" z.B. ist ein eigenständig geführtes,
// öffentliches Restaurant, das nur zufällig in einem Vereinsheim-Gebäude
// sitzt — der Name allein verrät das nicht zuverlässig).
const EXCLUDED_VENUE_OSM_IDS = new Set<number>([
  // "FC Ismaning Sportlerheim" — reine Vereinskantine ohne eigenen
  // Geschäftsnamen, kein für die Öffentlichkeit gedachtes Restaurant (per
  // Nutzer-Feedback gemeldet, 2026-07).
  185543054,
]);

interface OverpassElement {
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

type NearbyVenueCandidate = {
  osm_id: number;
  name: string;
  address: string | null;
  latitude: number;
  longitude: number;
  website?: string | null;
  phone?: string | null;
  opening_hours_raw?: string | null;
};

function normalizedVenueName(value: string): string {
  return value
    .toLocaleLowerCase('de')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function distanceMeters(a: NearbyVenueCandidate, b: NearbyVenueCandidate): number {
  const toRadians = (degrees: number) => degrees * Math.PI / 180;
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const deltaLat = lat2 - lat1;
  const deltaLon = toRadians(b.longitude - a.longitude);
  const h = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

function venueCompletenessScore(venue: NearbyVenueCandidate): number {
  return (venue.address ? 2 : 0)
    + (/\b\d{5}\b/.test(venue.address ?? '') ? 1 : 0)
    + (/m(?:ü|u)nchen/i.test(venue.address ?? '') ? 2 : 0)
    + (venue.website ? 1 : 0)
    + (venue.phone ? 1 : 0)
    + (venue.opening_hours_raw ? 1 : 0);
}

// OSM enthält gelegentlich zwei Nodes für denselben realen Ort. Nur bei
// identischem normalisiertem Namen UND unmittelbarer räumlicher Nähe wird
// zusammengeführt, damit gleichnamige Filialen erhalten bleiben. Der
// vollständigere Node gewinnt; fehlende Sachfelder werden vom zweiten Node
// ergänzt. Bei Gleichstand stabil den kleineren OSM-Identifier behalten.
export function dedupeNearbyVenues<T extends NearbyVenueCandidate>(venues: T[], maxDistanceMeters = 30): T[] {
  const result: T[] = [];
  for (const venue of venues) {
    const duplicateIndex = result.findIndex((candidate) =>
      normalizedVenueName(candidate.name) === normalizedVenueName(venue.name)
      && distanceMeters(candidate, venue) <= maxDistanceMeters
    );
    if (duplicateIndex < 0) {
      result.push(venue);
      continue;
    }

    const current = result[duplicateIndex];
    const venueWins = venueCompletenessScore(venue) > venueCompletenessScore(current)
      || (venueCompletenessScore(venue) === venueCompletenessScore(current) && venue.osm_id < current.osm_id);
    const winner = venueWins ? venue : current;
    const fallback = venueWins ? current : venue;
    result[duplicateIndex] = {
      ...fallback,
      ...winner,
      address: winner.address ?? fallback.address,
      website: winner.website ?? fallback.website,
      phone: winner.phone ?? fallback.phone,
      opening_hours_raw: winner.opening_hours_raw ?? fallback.opening_hours_raw,
    };
  }
  return result;
}

function buildAddress(tags: Record<string, string>): string | null {
  const streetLine = [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ');
  const cityLine = [tags['addr:postcode'], tags['addr:city']].filter(Boolean).join(' ');
  const parts = [streetLine, cityLine].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

// Fallback für OSM-Knoten ohne addr:street-Tag: die Koordinate kennen wir
// über Overpass immer, Nominatims Reverse-Geocoding kann daraus meist trotzdem
// eine Straße+Hausnummer ermitteln (gleiche kostenlose Quelle wie die
// Vorwärts-Geocodierung in core/geocode.ts).
async function reverseGeocodeAddress(lat: number, lon: number): Promise<string | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&addressdetails=1&zoom=18`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'VibeApp-Collector/1.0 (nicht-kommerziell, github.com/Lelawi/Vibe)' },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { address?: Record<string, string> };
    const a = json.address;
    if (!a) return null;
    const streetLine = [a.road, a.house_number].filter(Boolean).join(' ');
    const cityLine = [a.postcode, a.city ?? a.town ?? a.village].filter(Boolean).join(' ');
    const parts = [streetLine, cityLine].filter(Boolean);
    return parts.length > 0 ? parts.join(', ') : null;
  } catch (err) {
    console.warn('reverse geocode failed for', lat, lon, err);
    return null;
  }
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
  monday: 'Mo', tuesday: 'Tu', wednesday: 'We', thursday: 'Th', friday: 'Fr', saturday: 'Sa', sunday: 'Su',
  montag: 'Mo', dienstag: 'Tu', mittwoch: 'We', donnerstag: 'Th', freitag: 'Fr', samstag: 'Sa', sonntag: 'Su',
};
const DAY_ORDER = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

function dayNameToAbbr(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.split('/').pop() ?? value;
  return DAY_ABBR[name.toLocaleLowerCase('de-DE')] ?? null;
}

// schema.org erlaubt openingHours auch als einfachen String. WordPress-
// Plugins schreiben dort häufig ausgeschriebene Tagesnamen hinein (real bei
// Andys Seehäusl: "Monday,Tuesday,... 09:00-17:00"), während unser Parser
// bewusst OSM-Abkürzungen erwartet. Vor der Validierung beide verbreiteten
// Sprachvarianten normalisieren.
export function normalizeSchemaOpeningHours(value: string): string {
  let normalized = value.trim();
  for (const [dayName, abbr] of Object.entries(DAY_ABBR)) {
    normalized = normalized.replace(new RegExp(`\\b${dayName}\\b`, 'giu'), abbr);
  }
  return normalized;
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

// Deliberate 1:1-in-spirit duplicate of app/lib/openingHours.ts's
// parseOpeningHours/isWithinRules — same reason as canonicalizeVenue.ts
// (collectors can't import from app/, see CLAUDE.md architecture
// principle). Used PURELY as a strict validation gate below: free-text
// "Öffnungszeiten" sections on venue websites are normalized toward OSM
// syntax on a best-effort basis (extractFreeTextOpeningHours), and only
// accepted if the result actually parses cleanly here — garbage
// normalization simply fails this check and is discarded rather than
// silently stored as a wrong schedule. Keep in sync by hand if the real
// parser's rules change.
interface HoursDayRule {
  days: number[];
  ranges: { startMinutes: number; endMinutes: number }[];
  closed: boolean;
}
const HOURS_DAY_INDEX: Record<string, number> = { Su: 0, Mo: 1, Tu: 2, We: 3, Th: 4, Fr: 5, Sa: 6 };
function validateParseTimeToMinutes(time: string): number | null {
  const match = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 32 || minutes > 59) return null;
  return hours * 60 + minutes;
}
function validateParseDayToken(token: string): number[] | null {
  if (/^ph$/i.test(token)) return [];
  const rangeMatch = token.match(/^([A-Za-z]{2})-([A-Za-z]{2})$/);
  if (rangeMatch) {
    const start = HOURS_DAY_INDEX[rangeMatch[1]];
    const end = HOURS_DAY_INDEX[rangeMatch[2]];
    if (start === undefined || end === undefined) return null;
    const days: number[] = [];
    let i = start;
    while (true) {
      days.push(i);
      if (i === end) break;
      i = (i + 1) % 7;
      if (days.length > 7) return null;
    }
    return days;
  }
  const single = HOURS_DAY_INDEX[token];
  return single === undefined ? null : [single];
}
function validateParseTimeRangeToken(token: string): { startMinutes: number; endMinutes: number } | null {
  const match = token.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
  if (!match) return null;
  const start = validateParseTimeToMinutes(match[1]);
  const end = validateParseTimeToMinutes(match[2]);
  if (start === null || end === null) return null;
  return { startMinutes: start, endMinutes: end <= start ? end + 24 * 60 : end };
}
function validateOpeningHours(raw: string): HoursDayRule[] | null {
  const source = raw.trim();
  if (!source) return null;
  const rules: HoursDayRule[] = [];
  for (const block of source.split(';')) {
    const segment = block.trim();
    if (!segment) continue;
    let pendingDays: number[] = [];
    let lastRule: HoursDayRule | null = null;
    for (const part of segment.split(',')) {
      const piece = part.trim();
      if (!piece) continue;
      const tokens = piece.split(/\s+/);
      if (tokens.length < 1) continue;
      const days = validateParseDayToken(tokens[0]);
      if (days === null) {
        const bareRange = validateParseTimeRangeToken(piece);
        if (bareRange && !lastRule && pendingDays.length === 0 && rules.length === 0) {
          lastRule = { days: [0, 1, 2, 3, 4, 5, 6], ranges: [bareRange], closed: false };
          rules.push(lastRule);
          continue;
        }
        if (!lastRule || lastRule.closed) return null;
        const range = bareRange;
        if (!range) return null;
        lastRule.ranges.push(range);
        continue;
      }
      const rest = tokens.slice(1).join(' ');
      if (rest === '') { pendingDays.push(...days); lastRule = null; continue; }
      const allDays = [...new Set([...pendingDays, ...days])];
      pendingDays = [];
      if (/^(off|closed)$/i.test(rest)) { lastRule = { days: allDays, ranges: [], closed: true }; rules.push(lastRule); continue; }
      const range = validateParseTimeRangeToken(rest);
      if (!range) return null;
      lastRule = { days: allDays, ranges: [range], closed: false };
      rules.push(lastRule);
    }
    if (pendingDays.length > 0) return null;
  }
  return rules.length > 0 ? rules : null;
}

// Manche Venue-Websites veröffentlichen ihre Öffnungszeiten nur als
// Fließtext unter einer "Öffnungszeiten"-Überschrift statt als schema.org-
// Markup (per Live-Test an 20 zufälligen echten Venue-Websites verifiziert,
// 2026-07: 8 von 15 erreichbaren hatten so einen Abschnitt, keine davon
// strukturiertes Markup). Deutlich unregelmäßigeres Format als schema.org
// (Wochentage als "Montags"/"Mo"/"Di" statt einheitlich, "–"/"bis" statt
// "-", Dezimalpunkt statt Doppelpunkt bei Uhrzeiten, "Uhr" optional,
// mehrere Zeitfenster mit "&" statt Komma verbunden, "Öffnungszeiten"
// erscheint auf manchen Seiten zuerst nur als Navigations-Linktext gefolgt
// von unrelated Content, bevor der echte Öffnungszeiten-Absatz kommt).
// Wird deshalb aggressiv Richtung OSM-Syntax normalisiert, aber NUR
// übernommen, wenn das Ergebnis anschließend durch validateOpeningHours()
// oben tatsächlich sauber durchparst UND genug Wochentage abdeckt — bei
// Fehlschlag lieber nichts speichern statt zu raten.
const FREETEXT_DAY_MAP: [RegExp, string][] = [
  [/sonn-?\s*und\s*feiertag[e]?s?/gi, 'Su,PH'],
  [/feiertag[e]?s?/gi, 'PH'],
  [/montags?/gi, 'Mo'], [/dienstags?/gi, 'Tu'], [/mittwochs?/gi, 'We'],
  [/donnerstags?/gi, 'Th'], [/freitags?/gi, 'Fr'], [/samstags?/gi, 'Sa'], [/sonntags?/gi, 'Su'],
  // Deutsche Kurzformen (Di/Mi/Do/So) unterscheiden sich für 4 von 7 Tagen
  // von den hier intern genutzten OSM/englischen Tokens (Tu/We/Th/Su) — ohne
  // diese Zuordnung blieb z.B. "Sa - So" unerkannt (an einer echten
  // Website beobachtet).
  [/\bDi\b/g, 'Tu'], [/\bMi\b/g, 'We'], [/\bDo\b/g, 'Th'], [/\bSo\b/g, 'Su'],
];
const FREETEXT_TRAILING_NOISE =
  /\b(Kontakt|Anfahrt|Impressum|Reservieren|Adresse|Standort|Newsletter|Datenschutz|Facebook|Instagram|Social|Restaurant\s|Bar\s)\b/i;
const FREETEXT_DAY_TOK = '(?:Mo|Tu|We|Th|Fr|Sa|Su|PH)';

function normalizeFreeTextHoursCandidate(rawText: string): string {
  // Küche-Nebeninfo ("Küche jeweils bis 22:00 Uhr", "(Küche bis 21:30)")
  // zuerst entfernen, bevor ihre eigenen "."-Uhrzeiten spätere Schritte
  // verwirren können.
  let t = rawText.replace(/\(?\s*(warme\s+)?Küche\b[^)]{0,60}?(Uhr|\))/gi, ' ');
  // "UhrSamstags" (kein Leerzeichen zwischen zwei benachbarten Text-Knoten
  // im Quell-HTML) — Leerzeichen einfügen, damit der folgende Wochentag für
  // jede spätere \b-verankerte Regel unten eine echte Wortgrenze hat.
  t = t.replace(/Uhr(?=[A-ZÄÖÜ])/g, 'Uhr ');

  const noiseMatch = t.match(FREETEXT_TRAILING_NOISE);
  if (noiseMatch) t = t.slice(0, noiseMatch.index);

  for (const [re, abbr] of FREETEXT_DAY_MAP) t = t.replace(re, abbr);
  // Wochentag direkt an eine Ziffer geklebt ("Freitag11:30", "PH15.00") —
  // auch hier vor allen \b-abhängigen Regeln trennen (Buchstabe+Ziffer
  // zählen beide als \w, \b feuert zwischen ihnen sonst nicht).
  t = t.replace(new RegExp(`\\b(${FREETEXT_DAY_TOK})(\\d)`, 'g'), '$1 $2');

  t = t.replace(/[–—]/g, '-');
  t = t.replace(new RegExp(`\\b(${FREETEXT_DAY_TOK})\\s+bis\\s+(${FREETEXT_DAY_TOK})\\b`, 'gi'), '$1-$2');
  t = t.replace(new RegExp(`\\b(${FREETEXT_DAY_TOK})\\s*-\\s*(${FREETEXT_DAY_TOK})\\b`, 'g'), '$1-$2');
  t = t.replace(/(\d{1,2}[:.]\d{2})\s*bis\s*(\d{1,2}[:.]\d{2})/g, '$1-$2');
  t = t.replace(/(\d{1,2}[:.]\d{2})\s*bis\s*(\d{1,2})\b(?!:)/g, '$1-$2:00');
  t = t.replace(/\bvon\s+/gi, '');
  // Dezimalpunkt-Uhrzeit ("11.30", "22.30") -> Doppelpunkt. Nur 1-2 Ziffern,
  // Punkt, exakt 2 Ziffern — unrelated Zahlen (Preise, Adressen) matchen
  // dadurch kaum zufällig mit.
  t = t.replace(/\b(\d{1,2})\.(\d{2})\b/g, '$1:$2');
  // Reine Stunden-Spanne direkt vor "Uhr" ("8- 24 Uhr") -> ":00" ergänzen.
  t = t.replace(/\b(\d{1,2})\s*-\s*(\d{1,2})(?=\s*Uhr\b)/g, (_m, a: string, b: string) => `${a.padStart(2, '0')}:00-${b.padStart(2, '0')}:00`);
  t = t.replace(/\bgeschlossen\b/gi, 'off').replace(/\bruhetag\b/gi, 'off');
  // Doppelpunkt direkt nach einem Wochentag/einer Tagesliste ("Sa:", "PH:")
  // ist reine Interpunktion, keine Daten.
  t = t.replace(new RegExp(`\\b(${FREETEXT_DAY_TOK})\\s*:\\s*`, 'g'), '$1 ');
  // Fehlende Trenner zwischen benachbarten Tagesgruppen, wo das Quell-HTML
  // gar keinen Whitespace/keine Interpunktion dazwischen hatte (häufig:
  // "23:00 UhrSa...", "00:00 Tu Geschlossen", "off Sa-So ..."). Jede davon
  // muss eine eigenständige Regel werden (Semikolon), nicht versehentlich in
  // die Tage- oder Zeitliste der vorherigen verschmelzen.
  t = t.replace(/\s*Uhr(?=\s*(?:$|[A-ZÄÖÜ]))/g, '; ');
  t = t.replace(new RegExp(`(\\boff\\b)\\s+(?=${FREETEXT_DAY_TOK}\\b)`, 'gi'), '$1; ');
  t = t.replace(new RegExp(`(\\d{2}:\\d{2})\\s+(?=${FREETEXT_DAY_TOK}\\b)`, 'g'), '$1; ');
  t = t.replace(/\s*Uhr\b/gi, '');
  t = t.replace(/\s*&\s*/g, ', ');
  t = t.replace(/,\s*,/g, ',');
  t = t.replace(/;\s*;/g, ';');
  return t.trim();
}

function extractFreeTextOpeningHours($: cheerio.CheerioAPI): string | null {
  const bodyClone = $('body').clone();
  bodyClone.find('script, style, noscript').remove();
  const pageText = bodyClone.text().replace(/[ \t]+/g, ' ').replace(/\n+/g, ' ').trim();

  // Ein einzelner, klarer Hinweis auf eine dauerhafte Schließung IRGENDWO
  // auf der Seite ist ein absolutes Veto — real beobachtete Falle: ein ganz
  // normal aussehender Öffnungszeiten-Absatz weiter oben auf einer Seite,
  // die an anderer Stelle unmissverständlich sagt, dass dauerhaft
  // geschlossen ist (veraltete, nie entfernte alte Angabe).
  if (/dauerhaft\s+geschlossen|permanently\s+closed|für\s+immer\s+geschlossen/i.test(pageText)) return null;

  // Jedes Vorkommen von "Öffnungszeiten" ausprobieren, nicht nur das erste
  // — auf manchen Seiten erscheint es zuerst als reines Navigations-
  // Linklabel mit unrelated Content direkt danach, der echte Absatz erst
  // bei einem späteren Vorkommen.
  const heading = /Öffnungszeiten/gi;
  let m: RegExpExecArray | null;
  while ((m = heading.exec(pageText))) {
    const rawWindow = pageText.slice(m.index + m[0].length, m.index + m[0].length + 300);
    // "ab 22:00 Uhr" ganz ohne Ende-Zeit ist eine unvollständige Angabe
    // (variable Schließzeit) — lieber nichts speichern als eine Schließzeit
    // zu raten.
    if (/\bab\s+\d{1,2}[:.]\d{2}\s*Uhr\b/i.test(rawWindow.slice(0, 100)) && !/-/.test(rawWindow.slice(0, 100))) continue;

    const normalized = normalizeFreeTextHoursCandidate(rawWindow);
    // Nachfolgender Fließtext nach dem eigentlichen Öffnungszeiten-Absatz
    // (Marketing-Text, Städteliste, Navigations-Label ohne eigenen Treffer
    // in FREETEXT_TRAILING_NOISE) lässt den kompletten String scheitern,
    // obwohl der führende Teil ein einwandfreier Zeitplan ist — deshalb
    // zunächst den vollen String versuchen, dann schrittweise kürzere
    // Präfixe (an ";"-Grenzen, die der Normalisierer bereits zwischen
        // eigenständigen Tagesgruppen einfügt), bis einer sauber durchparst.
    const chunks = normalized.split(';').map((c) => c.trim()).filter(Boolean);
    for (let end = chunks.length; end > 0; end--) {
      const candidate = chunks.slice(0, end).join('; ');
      const parsed = validateOpeningHours(candidate);
      if (parsed && countCoveredDays(candidate) >= MIN_COVERED_DAYS) return candidate;
    }
  }
  return null;
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
        candidate = normalizeSchemaOpeningHours(n.openingHours);
      } else if (Array.isArray(n.openingHours) && n.openingHours.length) {
        const joined = n.openingHours
          .filter((v): v is string => typeof v === 'string')
          .map(normalizeSchemaOpeningHours)
          .join('; ');
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
      // Kein eigener Link, aber die Karte selbst steht direkt als Text auf
      // dieser Seite (z.B. 3d-restaurant-bar-neuhausen.de: "Unser
      // Mittagsmenü Mo-Fr 11:30-14:00 ..." direkt auf der Startseite, kein
      // separates PDF/Unterseite) — dann ist die Seite selbst der
      // sinnvollste Link, statt gar keinen zu zeigen (per Nutzer-Feedback).
      return { available: true, menuUrl: baseUrl };
    }
  }
  return { available: false, menuUrl: null };
}

// Abendkarte/allgemeine Speisekarte (Nutzer-Anfrage: "neben der Mittagskarte
// wäre auch bei den anderen die Abendkarte interessant") — anders als beim
// Mittagslunch (echtes Ja/Nein-Signal, nicht jedes Restaurant bietet das)
// gibt es hier keinen sinnvollen "verfügbar"-Filter: praktisch jedes
// bewirtete Restaurant hat irgendeine Haupt-/Abendkarte, daher nur der Link
// selbst von Interesse, kein zusätzliches Boolean-Feld. "Speisekarte" ist
// bewusst mit dabei (nicht nur "Abendkarte") — der weit verbreitetere
// deutsche Begriff für genau diese allgemeine/abendliche Karte, sobald eine
// separate Mittagskarte existiert bezeichnet "Speisekarte" praktisch immer
// die übrige (Abend-)Karte.
const DINNER_KEYWORDS = /abendkarte|abendmen[üu]|dinner[\s-]?menu|dinnerkarte|speisekarte/i;

function extractDinnerMenuUrl($: cheerio.CheerioAPI, baseUrl: string): string | null {
  let menuUrl: string | null = null;
  $('a[href]').each((_, el) => {
    if (menuUrl) return;
    const href = $(el).attr('href') ?? '';
    const text = $(el).text();
    if (DINNER_KEYWORDS.test(href) || DINNER_KEYWORDS.test(text)) {
      try {
        menuUrl = new URL(href, baseUrl).toString();
      } catch {
        menuUrl = null;
      }
    }
  });
  return menuUrl;
}

// Getränkekarte separat von der Speise-/Abendkarte — viele Websites trennen
// beides auf zwei eigene Unterseiten (per Direktabruf verifiziert, 2026-08:
// mehrere Restaurants mit verlinkter Speisekarte, deren Seitentext komplett
// ohne jede Bier-Erwähnung war — die eigentliche Getränkekarte lag auf einer
// eigenen, bis dahin nie gesuchten Unterseite). Für den Bierpreis
// ("extractBeerPrice"/"...FromPdf") ist genau diese Karte die
// zuverlässigste Quelle, deutlich eher als eine reine Speisekarte.
const DRINKS_KEYWORDS = /getränkekarte|getraenkekarte|barkarte|weinkarte|cocktailkarte|bierkarte|drinks?[\s-]?(menu|card|list)/i;

function extractDrinksMenuUrl($: cheerio.CheerioAPI, baseUrl: string): string | null {
  let menuUrl: string | null = null;
  $('a[href]').each((_, el) => {
    if (menuUrl) return;
    const href = $(el).attr('href') ?? '';
    const text = $(el).text();
    if (DRINKS_KEYWORDS.test(href) || DRINKS_KEYWORDS.test(text)) {
      try {
        menuUrl = new URL(href, baseUrl).toString();
      } catch {
        menuUrl = null;
      }
    }
  });
  return menuUrl;
}

// Preis für 0,5l Helles (Münchner Standardmaß, siehe Nutzer-Anfrage) — reine
// Bar-Kennzahl, aber unschädlich auch für Restaurants mitzuprüfen (liefert
// dort einfach meist nichts). Erfasst JEDE angegebene Gebindegröße (0,3l,
// 0,33l, 0,4l, 1,0l/Maß, ...) und rechnet linear auf den 0,5l-Preis um
// (price * 0,5/volumeL) — sonst wären zwei Drittel der überhaupt online
// auffindbaren Preise verloren gegangen, weil viele Bars ihr Helles gar
// nicht in 0,5l ausschenken. Bewusst weiterhin konservativ: nur akzeptiert,
// wenn "hell..." und eine Gebindegröße nah beieinander stehen — eine
// falsche Zahl wäre hier schädlicher als beim Mittagslunch-Badge (Nutzer
// könnte sich auf einen falschen Preis verlassen), daher lieber niedrige
// Trefferquote als geraten.
//
// Die Lücke zwischen "hell"/Volumen/Preis darf kurze Klammer-Fußnoten
// ("(a2)", "(1, 3)" — Allergen-/Zusatzstoff-Kennzeichnung) und ABV-Angaben
// ("5,3%") überspringen, bleibt aber sonst ziffernfrei — sonst könnte über
// einen echten anderen Preis hinweg zu einem falschen Treffer gebrückt
// werden. Ohne diese Ausnahmen wurden reale Treffer wie "Tegernseer Hell
// (a2) /0,5l vom Fass 4,50 €" und "HB Pure Hell 5,3% / 0,33l 5,50 EUR"
// verpasst, weil die Ziffern in "(a2)"/"5,3%" die ursprüngliche
// [^\d€]-Zeichenklasse blockierten (per Direktabruf an ~20 echten
// Getränkekarten verifiziert, 2026-07).
const BEER_GAP = '(?:[^\\d€()%]|\\([^)€]{0,10}\\)|\\d{1,2}(?:[.,]\\d{1,2})?%){0,35}';
// Kein \w* nach "hell": bei fehlendem Trenner zwischen Namen und Volumen
// ("Hell0.5l6.9", per Direktabruf beobachtet) frisst \w* sonst gierig die
// führende Ziffer des Volumens mit, da Ziffern zu \w gehören.
// [lLI] statt nur l: Großbuchstabe L ist die reguläre Einheit-Schreibweise
// ("0,4L"), I kommt als Font-/Ligatur-Verwechslung mit kleinem l vor (an
// einer echten Karte beobachtet). Preis mit 1-2 Nachkommastellen statt fest
// 2: englischsprachige Karten schreiben Preise gelegentlich verkürzt ("6.9"
// statt "6.90").
const BEER_VOLUME_PRICE_ROW = new RegExp(
  `hell${BEER_GAP}(\\d(?:[.,]\\d{1,2})?)\\s*[lLI]${BEER_GAP}(\\d{1,2}[.,]\\d{1,2})\\s*€` +
    `|(\\d(?:[.,]\\d{1,2})?)\\s*[lLI]${BEER_GAP}hell${BEER_GAP}(\\d{1,2}[.,]\\d{1,2})\\s*€`
);
// € nicht zwingend direkt am Preis (anders als im HTML-Fall): PDF-
// Preislisten drucken die Währung oft nur einmal als Spaltenüberschrift statt
// bei jeder einzelnen Zeile (per Direktabruf an mehreren echten
// Getränkekarten verifiziert). Ersatz-Absicherung: "€"/"EUR" muss
// wenigstens irgendwo im PDF vorkommen (siehe extractBeerPriceFromPdf),
// sonst ist es vermutlich gar keine Preisliste.
const BEER_VOLUME_PRICE_PDF = new RegExp(
  `hell${BEER_GAP}(\\d(?:[.,]\\d{1,2})?)\\s*[lLI]${BEER_GAP}(\\d{1,2}[.,]\\d{1,2})` +
    `|(\\d(?:[.,]\\d{1,2})?)\\s*[lLI]${BEER_GAP}hell${BEER_GAP}(\\d{1,2}[.,]\\d{1,2})`
);
// "Hell alkoholfrei" (alkoholfreies Weizen/Helles) und "Radler"/"Shandy"
// (Bier-Limo-Mix) sind andere Produkte als normales Helles vom Fass — ein
// Treffer, dessen Fundstelle eines dieser Wörter enthält, wird verworfen
// statt fälschlich als Standard-Helles-Preis übernommen zu werden (an
// echten Karten als reales Risiko beobachtet: "Maxlrainer Engerl Hell
// alkoholfrei / 0,50 l 6,50" und "Helles | Radler (a) 0,40 l 5.20"). Nur der
// tatsächlich gematchte Text (nicht zusätzlicher Kontext davor/danach)
// zählt — ein Ausschlusswort in einem GANZ ANDEREN, vorangehenden
// Menüpunkt (z.B. "Gösser Shandy" vor "Tegernseer Hell" in einer separaten
// Zeile) soll den folgenden, unabhängigen Treffer nicht fälschlich blockieren.
// Restaurants (anders als Bars) führen oft auch importierte Lagerbiere, und
// manche (mehrsprachige) Speisekarten benutzen "hell"/"hells" als lockere
// Stilbeschreibung für JEDES helle Lagerbier statt spezifisch für Münchner
// Helles (an einer echten Karte beobachtet: "0.25l Bier Hells Asahi 4,80" —
// ein japanisches Importbier, kein Münchner Helles). Für die hier gefragte
// Kennzahl ("was kostet ein Münchner Helles") zählt das nicht, auch wenn der
// Treffer technisch korrekt ist.
const EXCLUDE_OTHER_DRINK =
  /alkoholfrei|alcohol-free|alcoholfree|radler|shandy|asahi|corona|heineken|peroni|desperados|tsingtao|san miguel|sol\b|budweiser|carlsberg|kirin|sapporo/i;

// Nur für den HTML-Zeilen-Fall (nicht PDF, siehe extractBeerPrice): eine
// ganze Zeile/Absatz mit Wochentag oder Rabatt-Sprache signalisiert eine
// zeitlich begrenzte Sonderaktion statt des regulären Standardpreises (an
// einer echten Website beobachtet: "Sonntag: FETISCH Day... bekommt das
// 0,4l Helle für 4,00 €" — ein Event-Rabatt, kein Alltagspreis). Auf den
// HTML-Fall beschränkt, weil dort jede Zeile bereits durch die DOM-Struktur
// isoliert ist (kein Risiko, versehentlich einen unrelated vorangehenden
// Satz zu erwischen, wie es beim PDF-Fließtext ohne Zeilengrenzen passieren
// könnte — siehe EXCLUDE_OTHER_DRINK-Kommentar oben).
const PROMOTIONAL_CONTEXT =
  /montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|happy\s*hour|angebot|aktion|rabatt/i;

// Sucht mit einer globalen Kopie des übergebenen Patterns nach dem ersten
// Treffer, der NICHT auf ein anderes Getränk verweist (überspringt sonst
// weitere Kandidaten im selben Text), rechnet die gefundene Gebindegröße auf
// den 0,5l-Preis um und prüft das Ergebnis auf Plausibilität.
function findNormalizedBeerPrice(text: string, pattern: RegExp): number | null {
  const re = new RegExp(pattern.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (EXCLUDE_OTHER_DRINK.test(m[0])) continue;
    const volumeL = parseFloat((m[1] ?? m[3]).replace(',', '.'));
    const price = parseFloat((m[2] ?? m[4]).replace(',', '.'));
    if (Number.isNaN(volumeL) || Number.isNaN(price)) continue;
    if (volumeL < 0.2 || volumeL > 1.2) continue; // unplausible Gebindegröße für Bier
    if (price <= 1 || price > 20) continue;
    const normalized = Math.round((price * 0.5 / volumeL) * 100) / 100;
    // Untergrenze bewusst bei 3€ statt 2€: der günstigste über alle bisher
    // verifizierten echten Treffer (Bars + Restaurants) beobachtete Preis lag
    // bei 3,20€ — alles darunter war bislang immer ein Extraktionsfehler,
    // z.B. PDF-Spalten, die durch pdf-parses nicht-visuelle Textreihenfolge
    // durcheinandergeraten sind (an einer echten Karte beobachtet: "1,0l
    // Spaten München Hell I 5,2% Vol. 5,50" ergab normalisiert 2,75€ für
    // einen vollen Liter Maß — 2026 unmöglich billig, während dieselbe Karte
    // an anderer Stelle einen plausiblen 0,3l/3,90€-Treffer hatte).
    if (normalized < 3 || normalized > 12) continue; // Sanity-Range für einen 0,5l-Preis
    return normalized;
  }
  return null;
}

export function extractBeerPrice($: cheerio.CheerioAPI): number | null {
  let price: number | null = null;
  $('tr, li, p, div').each((_, el) => {
    if (price !== null) return;
    const rowText = $(el).text();
    // Nur die riesigen Seiten-Wrapper-Divs (ganze Seite/ganzer Screenbereich)
    // überspringen, nicht einzelne Menülisten — manche Websites packen eine
    // ganze Getränkekategorie in ein einziges <div> statt einzelner <li>
    // (an einer echten Website beobachtet: die komplette "Softdrink e
    // Birra"-Liste als ein 595-Zeichen-Div, das der frühere 300-Zeichen-
    // Deckel fälschlich überspringen ließ). Der eigentliche Schutz gegen
    // falsches Verbrücken zu einem unrelated Preis kommt ohnehin von der
    // engen BEER_GAP-Begrenzung selbst, nicht von der Zeilenlänge — 300 war
    // unnötig konservativ.
    if (rowText.length > 3000) return;
    if (PROMOTIONAL_CONTEXT.test(rowText)) return;
    price = findNormalizedBeerPrice(rowText, BEER_VOLUME_PRICE_ROW);
  });
  return price;
}

// Bar-Getränkekarten sind auf der Website selbst praktisch nie als HTML-Text
// hinterlegt (per Direktabruf verifiziert, 2026-07: 0 von 204 Bar-Websites
// mit Preis im HTML-Text) — fast immer ein verlinktes PDF.
const MENU_PDF_KEYWORDS = /karte|men[üu]|getr[äa]nk|getraenk|drinks|preis|bar/i;

// Sammelt PDF-Links von der Seite, Kandidaten mit Karten-typischen Begriffen
// im Link/Linktext zuerst — eine Website verlinkt oft mehrere PDFs
// (Datenschutz, Bankettmappe, Eventflyer...), von denen meist nur eins die
// eigentliche Getränkekarte ist. Auf 4 begrenzt, um die Laufzeit pro Venue
// nicht ausufern zu lassen.
function findMenuPdfLinks($: cheerio.CheerioAPI, baseUrl: string): string[] {
  const all = new Set<string>();
  const prioritized = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    if (!/\.pdf(\?|$)/i.test(href)) return;
    let url: string;
    try {
      url = new URL(href, baseUrl).toString();
    } catch {
      return;
    }
    all.add(url);
    const text = $(el).text();
    if (MENU_PDF_KEYWORDS.test(href) || MENU_PDF_KEYWORDS.test(text)) prioritized.add(url);
  });
  return (prioritized.size > 0 ? [...prioritized] : [...all]).slice(0, 4);
}

// pdf-parse/pdf.js loggen bei jeder etwas ungewöhnlichen PDF (kaputte
// Font-Tabellen, gescannte Speisekarten, verschlüsselte PDFs...) massenhaft
// "Warning: ..."-Zeilen über console.warn/console.log — bei den ~2000
// Restaurant-Websites kamen so über 100.000 Log-Zeilen zusammen, die eine
// echte Fehlermeldung (z.B. den Overpass-Timeout weiter unten) komplett
// zugeschüttet haben (per Nutzer-Log gemeldet). Das sind pdf.js-interne
// Diagnosemeldungen, keine echten Fehler unseres Codes — für die Dauer des
// Parsens stumm geschaltet statt jede einzelne Aufrufstelle zu patchen.
async function parsePdfQuietly(buffer: Buffer) {
  const originalWarn = console.warn;
  const originalLog = console.log;
  console.warn = () => {};
  console.log = () => {};
  try {
    return await pdf(buffer);
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
  }
}

export async function extractBeerPriceFromPdf(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'VibeApp-Collector/1.0 (nicht-kommerziell, github.com/Lelawi/Vibe)' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    const parsed = await parsePdfQuietly(buffer);
    if (!/€|EUR/i.test(parsed.text)) return null;
    return findNormalizedBeerPrice(parsed.text, BEER_VOLUME_PRICE_PDF);
  } catch {
    return null;
  }
}

// OSM selbst pflegt so gut wie nie ein "image"-Tag, aber viele Venues haben
// eine eigene Website mit og:image (dieselbe Quelle nutzen z.B.
// sources/auer_dult, sources/milla). Ein Abruf liefert best effort Bild,
// (falls vorhanden) genauere Öffnungszeiten, einen Mittagslunch-Hinweis und
// einen Bierpreis mit — schlägt alles fehl, bleiben die Felder einfach
// null/false, kein Venue fällt deswegen aus dem Lauf raus.
// Versucht einen Bierpreis direkt aus einer bereits bekannten Karten-URL zu
// lesen (PDF anhand der Dateiendung erkannt, sonst als HTML-Seite
// behandelt) — unabhängig davon, ob es eine Mittags- oder Abend-/
// Getränkekarte ist, beide können einen Getränketeil mit Bierpreisen
// enthalten.
export async function extractBeerPriceFromKnownMenuUrl(url: string): Promise<number | null> {
  if (/\.pdf(\?|$)/i.test(url)) return extractBeerPriceFromPdf(url);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'VibeApp-Collector/1.0 (nicht-kommerziell, github.com/Lelawi/Vibe)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    return extractBeerPrice(cheerio.load(html));
  } catch {
    return null;
  }
}

// cachedMenuUrls: bereits aus einem früheren Lauf bekannte Mittags-/Abend-
// kartenlinks (siehe collectVenues weiter unten) — werden VOR den generisch
// von der Startseite erratenen PDF-Kandidaten geprüft, weil sie bereits als
// echte Karte identifiziert wurden, statt nur nach Karten-typischen
// Schlagwörtern zu raten (per Nutzer-Wunsch: "fange mit den Venues an, von
// denen du eh bereits eine Karte hinterlegt hast").
export async function fetchWebsiteEnrichment(
  website: string,
  cachedMenuUrls: { lunch: string | null; dinner: string | null } = { lunch: null, dinner: null }
): Promise<{
  image: string | null;
  hours: string | null;
  lunchAvailable: boolean;
  lunchMenuUrl: string | null;
  dinnerMenuUrl: string | null;
  beerPriceEur: number | null;
}> {
  try {
    const res = await fetch(website, {
      headers: { 'User-Agent': 'VibeApp-Collector/1.0 (nicht-kommerziell, github.com/Lelawi/Vibe)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { image: null, hours: null, lunchAvailable: false, lunchMenuUrl: null, dinnerMenuUrl: null, beerPriceEur: null };
    const html = await res.text();
    const metaMatch = html.match(/<meta[^>]+property=["'](?:og|twitter):image["'][^>]+content=["']([^"']+)["']/i)
      ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["'](?:og|twitter):image["']/i)
      ?? html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
      ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
    // Relative Bild-URLs (z.B. "/images/hero.jpg") kommen vor — gegen die
    // Website-URL auflösen statt kaputte relative Pfade zu speichern.
    const image = metaMatch ? new URL(metaMatch[1], website).toString() : findBestImage(html, website);
    const $ = cheerio.load(html);
    // JSON-LD (strukturiert, zuverlässiger) zuerst versuchen, Fließtext-
    // Extraktion nur als Fallback, wenn die Seite kein Markup hat.
    const hours = extractOpeningHoursOverride($) ?? extractFreeTextOpeningHours($);
    const lunch = extractLunchSignal($, website);
    const dinnerMenuUrl = extractDinnerMenuUrl($, website);
    const drinksMenuUrl = extractDrinksMenuUrl($, website);
    let beerPriceEur = extractBeerPrice($);
    // Kein Preis im HTML-Text der Startseite gefunden — zuerst eine eigens
    // gefundene Getränkekarte (zuverlässigste Quelle für einen Bierpreis,
    // siehe extractDrinksMenuUrl-Kommentar), dann die bereits bekannten
    // Speise-/Abendkartenlinks direkt prüfen (zuverlässiger als Raten),
    // erst danach die von der Startseite neu erratenen PDF-Kandidaten.
    if (beerPriceEur === null) {
      for (const knownUrl of [drinksMenuUrl, dinnerMenuUrl, cachedMenuUrls.dinner, lunch.menuUrl, cachedMenuUrls.lunch]) {
        if (!knownUrl) continue;
        beerPriceEur = await extractBeerPriceFromKnownMenuUrl(knownUrl);
        if (beerPriceEur !== null) break;
      }
    }
    // Immer noch nichts — bei Bars (anders als Restaurants für den
    // Mittagslunch) fast immer der Fall, da Getränkekarten praktisch nie
    // als HTML-Text veröffentlicht werden. Verlinkte PDFs auf der
    // Startseite als letzten Fallback durchsuchen, statt hier aufzugeben.
    if (beerPriceEur === null) {
      for (const pdfLink of findMenuPdfLinks($, website)) {
        beerPriceEur = await extractBeerPriceFromPdf(pdfLink);
        if (beerPriceEur !== null) break;
      }
    }
    return { image, hours, lunchAvailable: lunch.available, lunchMenuUrl: lunch.menuUrl, dinnerMenuUrl, beerPriceEur };
  } catch {
    return { image: null, hours: null, lunchAvailable: false, lunchMenuUrl: null, dinnerMenuUrl: null, beerPriceEur: null };
  }
}

export interface CollectVenuesOptions {
  label: string;
  type: 'bar' | 'restaurant' | 'spaeti';
  // Spätis/Kioske sind in OSM über shop=kiosk|convenience|alcohol getaggt,
  // nicht über amenity= wie Bars/Restaurants — der Tag-Schlüssel muss daher
  // konfigurierbar sein statt hart auf "amenity" verdrahtet.
  tagKey?: 'amenity' | 'shop';
  amenityValues: string[];
}

export async function collectVenues({ label, type, tagKey = 'amenity', amenityValues }: CollectVenuesOptions): Promise<void> {
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
  ${amenityValues.map((a) => `node["${tagKey}"="${a}"](${MUNICH_BBOX});`).join('\n  ')}
);
out body;
`;

  try {
    // overpass.kumi.systems ist ein kostenloser, best-effort betriebener
    // Mirror ohne Uptime-Garantie — ein einzelner HeadersTimeoutError (per
    // Nutzer-Log gemeldet: Bars-Lauf brach komplett ohne ein einziges
    // aktualisiertes Venue ab) sollte den ganzen Lauf nicht scheitern lassen,
    // wenn ein zweiter Versuch eine Chance hat durchzukommen.
    let data: { elements: OverpassElement[] } | null = null;
    const OVERPASS_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= OVERPASS_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(OVERPASS_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/plain',
            'User-Agent': 'VibeApp-Collector/1.0 (nicht-kommerziell, github.com/Lelawi/Vibe)',
          },
          body: 'data=' + encodeURIComponent(overpassQuery),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        data = (await res.json()) as { elements: OverpassElement[] };
        break;
      } catch (err) {
        console.warn(`[${label}] overpass attempt ${attempt}/${OVERPASS_ATTEMPTS} failed`, err);
        if (attempt < OVERPASS_ATTEMPTS) await new Promise((r) => setTimeout(r, 5000 * attempt));
      }
    }
    if (!data) { console.warn(`[${label}] overpass fetch failed after ${OVERPASS_ATTEMPTS} attempts — skipping this run`); return; }
    const rawVenues = dedupeNearbyVenues(data.elements
      .filter((el) => el.tags?.name && !EXCLUDED_VENUE_OSM_IDS.has(el.id))
      .map((el) => {
        const tags = el.tags!;
        return {
          osm_id: el.id,
          name: tags.name,
          address: buildAddress(tags),
          // Nur ein Verarbeitungs-Flag, nicht Teil der venues-Zeile (wird vor
          // dem Upsert wieder entfernt) — merkt sich, ob der OSM-Knoten
          // überhaupt eine Straße kennt, damit unten gezielt nur die
          // Venues ohne Straße per Reverse-Geocoding nachgeschärft werden.
          hasStreetTag: Boolean(tags['addr:street']),
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
          // OSM kennt bei internet_access neben yes/no auch "wlan"
          // (ausdrücklich WLAN), "terminal" (nur ein Publikums-PC) und
          // "wired" (nur Kabel) — nur die ersten beiden zählen hier als
          // "hat WLAN", der Rest bleibt unbekannt (null) statt fälschlich
          // als "kein WLAN" gewertet zu werden.
          wifi:
            tags.internet_access === 'wlan' || tags.internet_access === 'yes'
              ? true
              : tags.internet_access === 'no'
              ? false
              : null,
          type,
          updated_at: new Date().toISOString(),
        };
      }));

    if (rawVenues.length === 0) { console.log(`[${label}] no venues parsed`); return; }

    // Bereits vorhandene image_url/opening_hours_override/lunch-Infos je
    // osm_id wiederverwenden statt bei jedem (wöchentlichen) Lauf alle
    // Websites erneut abzuklappern — nur für Venues, denen noch mindestens
    // eins davon fehlt, wird neu gefetcht.
    const { data: existing } = await supabase
      .from('venues')
      .select('osm_id,address,image_url,opening_hours_override,lunch_available,lunch_menu_url,dinner_menu_url,beer_price_eur')
      .eq('type', type);
    const existingByOsmId = new Map(
      (existing ?? []).map((v) => [
        v.osm_id as number,
        {
          address: v.address as string | null,
          image: v.image_url as string | null,
          hours: v.opening_hours_override as string | null,
          lunchAvailable: (v.lunch_available as boolean | null) ?? false,
          lunchMenuUrl: v.lunch_menu_url as string | null,
          dinnerMenuUrl: v.dinner_menu_url as string | null,
          beerPriceEur: v.beer_price_eur as number | null,
        },
      ])
    );

    // Manche OSM-Knoten haben keinen addr:street-Tag (bei Spätis/Kiosken
    // häufiger als bei Restaurants) — ohne Straße liefert die Google-Maps-
    // Freitextsuche bei Filialketten (z.B. "REWE To Go") mehrere Treffer
    // statt direkt zur richtigen Filiale zu springen (per Nutzer-Feedback).
    // Die Koordinate kennen wir aber immer, also per Nominatim-Reverse-
    // Geocoding einmalig eine Adresse nachschlagen — nur für Venues, die
    // weder jetzt noch beim letzten Lauf schon eine hatten, und strikt
    // sequenziell mit 1s Abstand (Nominatim erlaubt max. 1 Anfrage/Sekunde).
    const needsReverseGeocode = rawVenues.filter((v) => !v.hasStreetTag && !existingByOsmId.get(v.osm_id)?.address);
    console.log(`[${label}] reverse-geocoding`, needsReverseGeocode.length, 'venues with no street address in OSM');
    const reverseGeocodedByOsmId = new Map<number, string | null>();
    for (const v of needsReverseGeocode) {
      reverseGeocodedByOsmId.set(v.osm_id, await reverseGeocodeAddress(v.latitude, v.longitude));
      await new Promise((r) => setTimeout(r, 1100));
    }

    const toFetch = rawVenues.filter((v) => {
      const cached = existingByOsmId.get(v.osm_id);
      return v.website && (!cached || !cached.image || !cached.hours || !cached.lunchAvailable || !cached.dinnerMenuUrl || !cached.beerPriceEur);
    });
    console.log(`[${label}] fetching website enrichment for`, toFetch.length, 'venues missing an image, opening-hours override, lunch/dinner menu or beer price');
    const enrichmentByOsmId = new Map<
      number,
      { image: string | null; hours: string | null; lunchAvailable: boolean; lunchMenuUrl: string | null; dinnerMenuUrl: string | null; beerPriceEur: number | null }
    >();
    const CONCURRENCY = 6;
    let cursor = 0;
    async function worker() {
      while (cursor < toFetch.length) {
        const venue = toFetch[cursor++];
        const cached = existingByOsmId.get(venue.osm_id);
        enrichmentByOsmId.set(
          venue.osm_id,
          await fetchWebsiteEnrichment(venue.website!, {
            lunch: cached?.lunchMenuUrl ?? null,
            dinner: cached?.dinnerMenuUrl ?? null,
          })
        );
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    const venues = rawVenues.map((v) => {
      const { hasStreetTag, ...row } = v;
      const fetched = enrichmentByOsmId.get(v.osm_id);
      const cached = existingByOsmId.get(v.osm_id);
      return {
        ...row,
        address: v.address ?? cached?.address ?? reverseGeocodedByOsmId.get(v.osm_id) ?? null,
        image_url: fetched?.image ?? cached?.image ?? null,
        opening_hours_override: fetched?.hours ?? cached?.hours ?? null,
        // Bewusst || statt ?? (anders als bei den URL-/Preisfeldern
        // darunter): fetched.lunchAvailable ist ein echtes false, kein
        // null/undefined, sobald extractLunchSignal auf der (immer nur
        // einzeln gescrapten) Startseite nichts findet — ein reines
        // Nullish-Coalescing hätte einen einmal bestätigten Treffer bei
        // jedem künftigen Re-Fetch wieder verworfen, sobald die Karte selbst
        // nicht (mehr) auf der Startseite steht, z.B. weil sie nur auf einer
        // Unterseite verlinkt ist (per Nutzer-Feedback entdeckt, 2026-08-11:
        // Café Westends Mittagskarte steht nur auf /speisen, nie auf der
        // gescrapten Root-URL). Kein Signal zu finden ist genauso wenig ein
        // Beleg für "gibt es nicht mehr" wie anderswo im Projekt (siehe
        // Google-Places-Closure-Heuristik) — einmal bestätigt bleibt sticky
        // true, bis jemand es manuell zurücksetzt.
        lunch_available: fetched?.lunchAvailable || cached?.lunchAvailable || false,
        lunch_menu_url: fetched?.lunchMenuUrl ?? cached?.lunchMenuUrl ?? null,
        dinner_menu_url: fetched?.dinnerMenuUrl ?? cached?.dinnerMenuUrl ?? null,
        beer_price_eur: fetched?.beerPriceEur ?? cached?.beerPriceEur ?? null,
      };
    });

    console.log(`[${label}] upserting`, venues.length, 'venues');
    const { error } = await supabase.from('venues').upsert(venues, { onConflict: 'osm_id' });
    if (error) console.error(`[${label}] upsert error`, error);
  } catch (err) {
    console.warn(`[${label}] error`, err);
  }
}
