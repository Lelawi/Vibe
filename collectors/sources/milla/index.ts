import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { getCoordinates } from '../../core/geocode';
import { buildStableSourceId, dedupeBySourceId } from '../../core/scrape';

// milla-club.de rendert die Kategorie-Archivseite ungewöhnlich (ein voller
// Blogpost pro "Seite", Datum als Freitext irgendwo im Artikeltext, z.B.
// "~~~~~ 12.11.2026 Einlass 19:00 ~~~~~") — der RSS-Feed liefert dieselben
// Posts sauber strukturiert (Titel, Link, Volltext), das echte Konzertdatum
// muss trotzdem aus dem Volltext geregext werden, da RSS `pubDate` nur das
// Veröffentlichungsdatum des Blogposts ist, nicht der Konzerttermin.
const MILLA_FEED_URL = 'https://milla-club.de/category/event/feed/';
const MILLA_HOMEPAGE_URL = 'https://milla-club.de/';
const MILLA_ADDRESS = 'Holzstraße 28, 80469 München';
// Origin/Connection/Sec-Fetch-Site ergänzt (per Nutzer-Meldung, 2026-08-09:
// beide Endpunkte scheiterten konsequent mit 403, nicht mehr nur
// "sporadisch"). Lokal/vom Firmennetz aus per Direktabruf nicht
// reproduzierbar (beide, node-fetch und natives fetch, liefern dort 200) —
// spricht für denselben IP-Reputationsblock gegen GitHub-Actions-Cloud-IPs
// wie bei den in-muenchen.de-Quellen (siehe collect-all.ts-Kommentar), nicht
// für ein grundsätzliches Header-/Fetch-Client-Problem. Trotzdem dieselben
// zusätzlichen Header ergänzt, die bei eventim (siehe sources/eventim/
// index.ts) nachweislich einen ähnlichen WAF-Block behoben haben — auf
// eigenes Risiko ohne hier reproduzierbaren Vorher/Nachher-Vergleich.
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
  Referer: 'https://milla-club.de/',
  'Cache-Control': 'no-cache',
  Origin: 'https://milla-club.de',
  Connection: 'keep-alive',
  'Sec-Fetch-Site': 'same-origin',
};

type HomepageEvent = {
  title: string;
  link: string;
  start_date: string;
  start_time: string | null;
  image_url: string | null;
};

const MONTH_NUMBER: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
};

export function parseMillaHomepage(html: string): HomepageEvent[] {
  const $ = cheerio.load(html);
  const events: HomepageEvent[] = [];
  $('.events .section__header').each((_, header) => {
    const heading = $(header).text().replace(/\s+/g, ' ').trim();
    const monthMatch = heading.match(/^([A-Za-z]+)\s+(\d{4})$/);
    if (!monthMatch) return;
    const month = MONTH_NUMBER[monthMatch[1].toLowerCase()];
    if (!month) return;
    const year = monthMatch[2];
    $(header).next('.columns').find('.event').each((__, card) => {
      const event = $(card);
      const dateText = event.find('.column.is-date').first().text().replace(/\s+/g, ' ').trim();
      const dayMatch = dateText.match(/\b(\d{1,2})\b/);
      const titleElement = event.find('.event__title h3').first();
      const title = (titleElement.attr('title') || titleElement.clone().children().remove().end().text()).trim();
      const link = event.find('.event__title a').first().attr('href')?.trim() ?? '';
      if (!dayMatch || !title || !link) return;
      const timeText = event.find('.columns.is-gapless .column').eq(1).text().replace(/\s+/g, ' ').trim();
      const timeMatch = timeText.match(/\b(\d{1,2})[.:](\d{2})\b/);
      events.push({
        title,
        link,
        start_date: `${year}-${month}-${dayMatch[1].padStart(2, '0')}`,
        start_time: timeMatch ? `${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}` : null,
        image_url: event.find('.event__thumbnail img').first().attr('src')?.trim() || null,
      });
    });
  });
  return events;
}

async function fetchWithRetry(url: string, label: string): Promise<Awaited<ReturnType<typeof fetch>> | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, { headers: BROWSER_HEADERS });
      if (res.ok) return res;
      console.warn(`[milla] ${label} failed`, res.status, `(attempt ${attempt}/2)`);
      if (res.status !== 403 && res.status !== 429 && res.status < 500) return null;
    } catch (error) {
      console.warn(`[milla] ${label} error (attempt ${attempt}/2)`, error);
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  return null;
}

// Der RSS-Feed selbst enthält kein Bild, die einzelne Event-Seite aber ein
// og:image (per Direktabruf verifiziert) — bei nur ~10 Events pro Lauf ist
// ein Zusatzabruf pro Event hier unproblematisch (anders als bei den
// in-muenchen.de-Quellen mit 50-100+ Events).
async function fetchMillaImage(eventUrl: string): Promise<string | null> {
  try {
    const res = await fetch(eventUrl, { headers: BROWSER_HEADERS });
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(/<meta property="og:image" content="([^"]+)"/);
    return match ? match[1] : null;
  } catch {
    return null;
  } finally {
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function run() {
  console.log('[milla] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[milla] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const collected: any[] = [];
  const today = new Date().toISOString().slice(0, 10);

  try {
    console.log('[milla] fetching', MILLA_FEED_URL);
    const coords = await getCoordinates(supabase, 'Milla Club', MILLA_ADDRESS, 'München');
    const feedResponse = await fetchWithRetry(MILLA_FEED_URL, 'feed fetch');
    if (feedResponse) {
      const xml = await feedResponse.text();
      const $ = cheerio.load(xml, { xmlMode: true });

      // Erst synchron aus dem Feed extrahieren (cheerios .each() kann nicht auf
      // async Bild-Abrufe warten), Bild danach pro Event einzeln nachladen.
      const rawItems: { title: string; link: string; content: string }[] = [];
      $('item').each((_, el) => {
        const item$ = $(el);
        const title = item$.find('title').first().text().trim();
        const link = item$.find('link').first().text().trim();
        const content = item$.find('content\\:encoded').first().text() || item$.find('description').first().text();
        if (title && link && content) rawItems.push({ title, link, content });
      });

      for (const { title, link, content } of rawItems) {
        const dateMatch = content.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
        if (!dateMatch) continue;
        const [, day, month, year] = dateMatch;
        const start_date = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
        if (start_date < today) continue;
        const timeMatch = content.match(/Beginn\s*(\d{1,2})[:.](\d{2})/i) ?? content.match(/Einlass\s*(\d{1,2})[:.](\d{2})/i);
        const plainText = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
        // \b-Wortgrenzen sind hier Pflicht: ohne sie matchte "AK" auch als
        // Teilstring in normalen (oft englischen) Beschreibungswörtern wie
        // "make"/"break"/"shake" — price_info bestand dann aus einem
        // zufälligen Fließtext-Fragment statt eines echten Preises (per
        // Nutzer-Screenshot, 2026-08-08: "Múr" zeigte einen Satzfetzen aus
        // "...make vastly different things...").
        const priceMatch = plainText.match(/\b(VVK|AK|Eintritt)\b[^~]{0,80}/i);
        collected.push({
          source_id: buildStableSourceId('milla', link, start_date), title, description: null,
          category: 'Clubs', subcategory: null, start_date,
          start_time: timeMatch ? `${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}` : null,
          location_name: 'Milla Club', address: MILLA_ADDRESS, city: 'München', organizer: 'Milla Club',
          source_url: link, image_url: await fetchMillaImage(link),
          price_info: priceMatch ? priceMatch[0].trim() : null, sold_out: null,
          latitude: coords?.latitude ?? null, longitude: coords?.longitude ?? null,
        });
      }
    }

    // Cloudflare blockiert den Kategorie-Feed aus GitHub Actions sporadisch
    // mit 403. Die öffentliche Startseite enthält dieselben Termine als
    // strukturierte Karten und ist deshalb Fallback und zugleich Ergänzung:
    // der WordPress-Feed ist auf wenige neue Posts begrenzt, während die
    // Startseite das vollständige zukünftige Programm ausliefert.
    console.log(collected.length === 0
      ? '[milla] feed unavailable or empty — falling back to homepage'
      : '[milla] supplementing feed from homepage');
    const homepageResponse = await fetchWithRetry(MILLA_HOMEPAGE_URL, 'homepage fetch');
    if (homepageResponse) {
      const knownSourceIds = new Set(collected.map((event) => event.source_id));
      for (const event of parseMillaHomepage(await homepageResponse.text())) {
        if (event.start_date < today) continue;
        const sourceId = buildStableSourceId('milla', event.link, event.start_date);
        // Feed-Daten haben zusätzlich Preisinfos aus dem Volltext und sollen
        // für dieselbe Veranstaltung nicht vom schlankeren Karten-Fallback
        // überschrieben werden.
        if (knownSourceIds.has(sourceId)) continue;
        knownSourceIds.add(sourceId);
        collected.push({
          source_id: sourceId,
          title: event.title, description: null, category: 'Clubs', subcategory: null,
          start_date: event.start_date, start_time: event.start_time,
          location_name: 'Milla Club', address: MILLA_ADDRESS, city: 'München', organizer: 'Milla Club',
          source_url: event.link, image_url: event.image_url, price_info: null, sold_out: null,
          latitude: coords?.latitude ?? null, longitude: coords?.longitude ?? null,
        });
      }
    } else if (collected.length === 0) {
      return;
    }
  } catch (err) {
    console.warn('[milla] error', err);
  }

  if (collected.length === 0) { console.log('[milla] no events parsed'); return; }
  console.log('[milla] upserting', collected.length, 'events');
  const { error } = await supabase.from('events').upsert(dedupeBySourceId(collected), { onConflict: 'source_id' });
  if (error) console.error('[milla] upsert error', error);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

export default run;
