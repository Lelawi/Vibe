import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';

const API_URL =
  'https://public-api.eventim.com/websearch/search/api/exploration/v1/products';
const TOP = 50;
const MAX_THROTTLE_RETRIES = 3;
// Der 180-Tage-Lauf kann mehr als hundert Requests erzeugen. Ohne Abstand
// wertet Eventims Schutzsystem diese Burst-Sequenz zeitweise als unerwünscht
// und antwortet aus GitHub Actions mit 403 statt mit dem semantisch passenderen
// 429. Bewusst sequenziell und knapp unter einem Request pro Sekunde.
const REQUEST_SPACING_MS = 1100;
const TIME_WINDOWS = [
  { from: '00:00', to: '11:59' },
  { from: '12:00', to: '17:59' },
  { from: '18:00', to: '23:59' },
];
// Kein fixes "nächste Woche"-Fenster mehr: es gibt keinen Grund, feststehende
// Termine erst kurz vorher abzugreifen, wenn Konzerte oft Monate im Voraus
// ausverkauft sind. Statt eines festen Zeitraums wird rekursiv in immer
// kleinere Zeitfenster gesplittet, aber nur dort, wo die API tatsächlich mehr
// als TOP=50 Treffer für den Zeitraum liefert — dünn besetzte Monate kosten
// dann nur einen einzigen Request, dicht besetzte Tage werden wie bisher per
// Tageszeit-Fenster weiter aufgesplittet.
//
// HORIZON_DAYS=180 statt "unendlich": ein Testlauf gegen die Live-API zeigte
// ~130 Requests allein für 90 Tage (Münchens Katalog ist sehr dicht, u.a.
// täglich wiederkehrende Stadtführungen/Museumstickets) — 180 Tage decken
// praktisch alle vorab planbaren/ausverkaufbaren Konzerte ab, ohne den
// 2x-täglichen collect-all-Lauf mit hunderten Requests zu belasten oder
// unnötig das Risiko einer 429-Drosselung zu erhöhen.
const HORIZON_DAYS = 180;

interface EventimCategory {
  name?: string;
  parentCategory?: { name?: string };
}

export interface EventimProduct {
  productId?: string;
  productGroupId?: string;
  name?: string;
  link?: string;
  price?: number;
  currency?: string;
  status?: string;
  inStock?: boolean;
  imageUrl?: string;
  typeAttributes?: {
    liveEntertainment?: {
      startDate?: string;
      endDate?: string;
      location?: {
        name?: string;
        city?: string;
        postalCode?: string;
        geoLocation?: {
          latitude?: number;
          longitude?: number;
        };
      };
    };
  };
  categories?: EventimCategory[];
}

interface EventimResponse {
  products: EventimProduct[];
  totalResults: number;
}

interface HttpResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

type Fetcher = (
  url: string,
  init: { headers: Record<string, string> }
) => Promise<HttpResponse>;

const defaultFetcher: Fetcher = (url, init) => fetch(url, init);
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
}

// Heutiges Datum in Europe/Berlin als UTC-Mitternacht-Date, damit
// Tagesarithmetik (addDays/daysBetween) nicht an DST-Verschiebungen
// vorbeirechnet.
export function berlinToday(reference = new Date()): Date {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(reference);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return new Date(Date.UTC(value('year'), value('month') - 1, value('day')));
}

function retryDelayMs(header: string | null, attempt: number): number {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  return 1000 * 2 ** attempt;
}

function buildUrl(dateFrom: string, dateTo: string, timeWindow?: { from: string; to: string }): string {
  const query = new URLSearchParams({
    webId: 'web__eventim-de',
    language: 'de',
    page: '1',
    retail_partner: 'EVE',
    city_names: 'München',
    date_from: dateFrom,
    date_to: dateTo,
    sort: 'DateAsc',
    top: String(TOP),
  });
  if (timeWindow) {
    query.set('time_from', timeWindow.from);
    query.set('time_to', timeWindow.to);
  }
  return `${API_URL}?${query}`;
}

async function fetchRange(
  dateFrom: string,
  dateTo: string,
  timeWindow: { from: string; to: string } | undefined,
  fetcher: Fetcher,
  sleep: (ms: number) => Promise<void>
): Promise<EventimResponse> {
  const url = buildUrl(dateFrom, dateTo, timeWindow);

  for (let attempt = 0; attempt <= MAX_THROTTLE_RETRIES; attempt++) {
    const response = await fetcher(url, {
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.7',
        // Die Public-API lehnt anonyme Runtime-Standard-User-Agents teilweise
        // mit 403 ab. Ein normaler Browser-UA plus Eventim-Referer entspricht
        // dem Request, den die öffentliche Website selbst an diesen Endpoint
        // sendet; es wird kein Proxy oder Bot-Schutz umgangen.
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
        Referer: 'https://www.eventim.de/',
      },
    });

    if (response.status === 403 || response.status === 429) {
      if (attempt === MAX_THROTTLE_RETRIES) {
        throw new Error(`EVENTIM API antwortete nach ${attempt + 1} Versuchen weiter mit ${response.status}`);
      }
      const headerDelay = retryDelayMs(response.headers.get('retry-after'), attempt);
      // Bei 403 deutlich länger abkühlen als bei einem regulären 429. Ein
      // sofortiger Retry verschärft eine temporäre WAF-Drosselung nur.
      const delay = response.status === 403
        ? Math.max(headerDelay, 5000 * 3 ** attempt)
        : headerDelay;
      console.warn(`[eventim] status ${response.status}; retrying in ${delay} ms`);
      await sleep(delay);
      continue;
    }

    if (!response.ok) {
      throw new Error(
        `EVENTIM Public API antwortete mit Status ${response.status}; ` +
        'Zugriff aus dieser Laufzeit ist möglicherweise serverseitig gesperrt'
      );
    }

    const body = await response.json() as Partial<EventimResponse>;
    if (!Array.isArray(body.products) || typeof body.totalResults !== 'number') {
      throw new Error('EVENTIM API lieferte ein unerwartetes Antwortformat');
    }
    await sleep(REQUEST_SPACING_MS);
    return { products: body.products, totalResults: body.totalResults };
  }

  throw new Error('EVENTIM API konnte nicht abgerufen werden');
}

// Rekursiv halbiert, bis ein Zeitraum <= TOP Treffer hat oder nur noch einen
// einzelnen Tag umfasst — an einem einzelnen (weiterhin zu vollen) Tag wird
// wie bisher per Tageszeit-Fenster nachsortiert.
async function collectRange(
  from: Date,
  to: Date,
  fetcher: Fetcher,
  sleep: (ms: number) => Promise<void>,
  collected: EventimProduct[]
): Promise<void> {
  const fromStr = isoDate(from);
  const toStr = isoDate(to);
  const { products, totalResults } = await fetchRange(fromStr, toStr, undefined, fetcher, sleep);
  console.log(`[eventim] ${fromStr}..${toStr}: totalResults=${totalResults}, products=${products.length}`);

  if (totalResults <= TOP) {
    collected.push(...products);
    return;
  }

  const spanDays = daysBetween(from, to);
  if (spanDays > 1) {
    const firstHalfDays = Math.floor(spanDays / 2);
    const mid = addDays(from, firstHalfDays - 1);
    await collectRange(from, mid, fetcher, sleep, collected);
    await collectRange(addDays(mid, 1), to, fetcher, sleep, collected);
    return;
  }

  for (const timeWindow of TIME_WINDOWS) {
    const partial = await fetchRange(fromStr, fromStr, timeWindow, fetcher, sleep);
    console.log(
      `[eventim] ${fromStr} ${timeWindow.from}-${timeWindow.to}: ` +
      `totalResults=${partial.totalResults}, products=${partial.products.length}`
    );
    collected.push(...partial.products);
  }
}

export async function collectUpcomingProducts(
  reference = new Date(),
  fetcher: Fetcher = defaultFetcher,
  sleep: (ms: number) => Promise<void> = wait,
  horizonDays = HORIZON_DAYS
): Promise<EventimProduct[]> {
  const collected: EventimProduct[] = [];
  const start = berlinToday(reference);
  await collectRange(start, addDays(start, horizonDays - 1), fetcher, sleep, collected);

  const unique = new Map<string, EventimProduct>();
  for (const product of collected) {
    const event = product.typeAttributes?.liveEntertainment;
    // city_names=München filtert bereits serverseitig, location.city hier
    // ist nur ein zusätzlicher Client-Check gegen Grenzfälle. Früher wurde
    // stattdessen exakt auf eine einzelne Postleitzahl gematcht (>90% von
    // München verwarf das stillschweigend, da eine Adresse nie zwei PLZs
    // gleichzeitig hat) — city deckt die ganze Stadt ab und braucht keine
    // Konfiguration.
    if (
      product.productId &&
      event?.startDate &&
      !Number.isNaN(Date.parse(event.startDate)) &&
      event.location?.city === 'München' &&
      !unique.has(product.productId)
    ) {
      unique.set(product.productId, product);
    }
  }

  return Array.from(unique.values()).sort((a, b) => {
    const aStart = a.typeAttributes!.liveEntertainment!.startDate!;
    const bStart = b.typeAttributes!.liveEntertainment!.startDate!;
    return Date.parse(aStart) - Date.parse(bStart);
  });
}

function berlinDateTime(value: string | undefined): { date: string; time: string } | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value;
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    time: `${part('hour')}:${part('minute')}`,
  };
}

function categoryFields(categories: EventimCategory[] | undefined) {
  const category =
    categories?.find((item) => !item.parentCategory)?.name ??
    categories?.find((item) => item.parentCategory)?.parentCategory?.name ??
    'Sonstiges';
  const subcategory =
    categories
      ?.map((item) => item.name)
      .filter((name): name is string => Boolean(name && name !== category))
      .join(', ') || null;
  return { category, subcategory };
}

function priceInfo(price: number | undefined, currency: string | undefined): string | null {
  // In der events-Tabelle bedeutet NULL ausdrücklich "keine Preisinfo verfügbar".
  if (price == null) return null;
  if (price === 0) return 'Kostenlos';
  if (!currency) return `ab ${price.toLocaleString('de-DE')}`;
  try {
    return `ab ${new Intl.NumberFormat('de-DE', {
      style: 'currency',
      currency,
    }).format(price)}`;
  } catch {
    return `ab ${price.toLocaleString('de-DE')} ${currency}`;
  }
}

// Eventim bietet denselben Termin teilweise als mehrere Produkte an. Die
// Ticketkategorie bleibt im Titel erhalten, damit die Detailansicht Standard,
// Premium und VIP benennen kann. Der Dedup-Lauf bereinigt sie nur für den
// Vergleich und blendet die Varianten im Feed aus.
export function normalizeEventimTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim();
}

export function normalizeEvent(product: EventimProduct) {
  const live = product.typeAttributes?.liveEntertainment;
  const start = berlinDateTime(live?.startDate);
  if (!product.productId || !product.name || !product.link || !start) return null;
  const end = berlinDateTime(live?.endDate);
  const location = live?.location;
  const { category, subcategory } = categoryFields(product.categories);
  const unavailableStatus = /cancel|unavailable|sold.?out/i.test(product.status ?? '');
  // Eventim liefert bei einzelnen Jurassic-World-Zeitfenstertickets vereinzelt
  // das Ende des gesamten Monats als endDate. Das macht einen bereits
  // vergangenen Tag fälschlich zu einem laufenden Mehrtages-Event und hält
  // dessen abgelaufenen Produktlink im Feed. Flextickets behalten dagegen
  // bewusst ihren echten Monatszeitraum.
  const isDateSpecificTimeSlot = /zeitfenstertickets/i.test(product.link);
  const normalizedEndDate =
    isDateSpecificTimeSlot && end?.date !== start.date ? null : end?.date ?? null;

  return {
    source_id: `eventim-${product.productId}`,
    title: normalizeEventimTitle(product.name),
    description: null,
    category,
    subcategory,
    start_date: start.date,
    start_time: start.time,
    end_date: normalizedEndDate,
    location_name: location?.name ?? null,
    address: null,
    city: location?.city ?? 'München',
    organizer: null,
    source_url: product.link,
    image_url: product.imageUrl ?? null,
    price_info: priceInfo(product.price, product.currency),
    sold_out:
      product.inStock === false || unavailableStatus
        ? true
        : product.inStock === true
          ? false
          : null,
    latitude: location?.geoLocation?.latitude ?? null,
    longitude: location?.geoLocation?.longitude ?? null,
  };
}

export async function run() {
  console.log('[eventim] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.log('[eventim] missing Supabase envs — skipping');
    return;
  }

  const products = await collectUpcomingProducts();
  const events = products.map(normalizeEvent).filter((event) => event !== null);
  if (events.length === 0) {
    console.log('[eventim] no events found');
    return;
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  const { error } = await supabase
    .from('events')
    .upsert(events, { onConflict: 'source_id' });
  if (error) throw error;
  console.log(`[eventim] ${events.length} events saved/updated`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().then(() => process.exit(0)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export default run;
