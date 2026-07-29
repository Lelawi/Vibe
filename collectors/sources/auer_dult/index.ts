import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { getCoordinates } from '../../core/geocode';

// Die Auer Dult findet 3x im Jahr auf dem Mariahilfplatz statt (Maidult,
// Jakobidult, Kirchweihdult) und läuft jeweils über mehrere Tage. Die
// offizielle Seite listet die Termine als Fließtext statt strukturierter
// Daten, z.B. "Maidult: 25. April bis 3. Mai" (per Direktabruf verifiziert,
// 2026-07) — Start- und Enddatum werden hier getrennt geregext, da beide
// Monate unterschiedlich sein können.
const AUER_DULT_URL = 'https://www.auerdult.de/dultinfo';
const AUER_DULT_ADDRESS = 'Mariahilfplatz, 81541 München';
const DULT_NAMES = ['Maidult', 'Jakobidult', 'Kirchweihdult'];
const MONTH_NAMES = 'januar|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember';
const GERMAN_MONTHS: Record<string, number> = {
  januar: 1, februar: 2, märz: 3, april: 4, mai: 5, juni: 6, juli: 7,
  august: 8, september: 9, oktober: 10, november: 11, dezember: 12,
};

function toDateStr(year: number, month: number, day: number): string {
  // Date.UTC statt new Date(y,m,d) + toISOString, sonst verschiebt die
  // lokale Zeitzone (CET/CEST) das Datum bei der UTC-Konvertierung u.U. um
  // einen Tag.
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

export async function run() {
  console.log('[auer-dult] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) { console.log('[auer-dult] missing supabase envs — skipping'); return; }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const collected: any[] = [];

  try {
    console.log('[auer-dult] fetching', AUER_DULT_URL);
    const res = await fetch(AUER_DULT_URL, { headers: { 'User-Agent': 'VibeApp-Collector/1.0' } });
    if (!res.ok) { console.warn('[auer-dult] fetch failed', res.status); return; }
    const html = await res.text();
    const $ = cheerio.load(html);
    const text = $('body').text().replace(/\s+/g, ' ');
    // Ein einziges generisches Foto für die Seite (nicht pro Dult), aber ein
    // echtes Marktfoto statt gar keinem Bild — per Direktabruf verifiziert.
    const imageUrl = $('meta[property="og:image"]').attr('content') || null;

    const coords = await getCoordinates(supabase, 'Auer Dult', AUER_DULT_ADDRESS, 'München');

    for (const dultName of DULT_NAMES) {
      const idx = text.indexOf(dultName);
      if (idx === -1) continue;
      // Sucht im Text nach dem Dult-Namen "<Tag>. <Monat> bis <Tag>. <Monat>",
      // z.B. "Maidult: 25. April bis 3. Mai" — Start- und Endmonat getrennt
      // geregext, da sie unterschiedlich sein können. Die Seite nennt kein
      // Jahr direkt dabei, das wird über die Rollover-Logik unten bestimmt.
      const window = text.slice(idx, idx + 200);
      const startMatch = window.match(new RegExp(`:\\s*(\\d{1,2})\\.\\s*(${MONTH_NAMES})`, 'i'));
      const endMatch = window.match(new RegExp(`bis\\s*(\\d{1,2})\\.\\s*(${MONTH_NAMES})`, 'i'));
      if (!startMatch) continue;

      const startDay = parseInt(startMatch[1], 10);
      const startMonth = GERMAN_MONTHS[startMatch[2].toLowerCase()];
      const endDay = endMatch ? parseInt(endMatch[1], 10) : null;
      const endMonth = endMatch ? GERMAN_MONTHS[endMatch[2].toLowerCase()] : null;

      // Rollover anhand des ENDdatums prüfen, nicht des Startdatums — sonst
      // würde eine Dult, die schon begonnen hat aber noch läuft (Start in der
      // Vergangenheit, Ende in der Zukunft), fälschlich ins nächste Jahr
      // verschoben statt als laufend erkannt zu werden.
      const now = new Date();
      const todayUtc = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
      let year = now.getFullYear();
      const tentativeEndMonth = endMonth ?? startMonth;
      const tentativeEndDay = endDay ?? startDay;
      // Dult übers Jahresende (aktuell bei keiner der drei der Fall, aber
      // sicherheitshalber): Endmonat "kleiner" als Startmonat -> ein Jahr weiter.
      const tentativeEndYear = endMonth !== null && endMonth < startMonth ? year + 1 : year;
      if (new Date(Date.UTC(tentativeEndYear, tentativeEndMonth - 1, tentativeEndDay)) < todayUtc) {
        year += 1;
      }
      const start_date = toDateStr(year, startMonth, startDay);

      let end_date: string | null = null;
      if (endMonth !== null && endDay !== null) {
        const endYear = endMonth < startMonth ? year + 1 : year;
        end_date = toDateStr(endYear, endMonth, endDay);
      }

      const sourceId = `auer-dult-${dultName.toLowerCase()}-${start_date.slice(0, 4)}`;
      collected.push({
        source_id: sourceId,
        title: `${dultName} auf dem Mariahilfplatz`,
        description: `Termin laut ${AUER_DULT_URL}: ${window.trim().slice(0, 150)}`,
        category: 'Märkte',
        subcategory: 'Dult',
        start_date,
        end_date,
        start_time: null,
        location_name: 'Auer Dult',
        address: AUER_DULT_ADDRESS,
        city: 'München',
        organizer: 'Landeshauptstadt München',
        source_url: AUER_DULT_URL,
        image_url: imageUrl,
        // Marktzugang ist wie bei allen Münchner Dulten frei — bezahlt wird
        // nur pro Fahrgeschäft/Stand, nicht fürs Betreten.
        price_info: 'Kostenlos',
        latitude: coords?.latitude ?? null,
        longitude: coords?.longitude ?? null,
      });
    }
  } catch (err) {
    console.warn('[auer-dult] error', err);
  }

  if (collected.length === 0) { console.log('[auer-dult] no events parsed'); return; }
  console.log('[auer-dult] upserting', collected.length, 'events');
  const { error } = await supabase.from('events').upsert(collected, { onConflict: 'source_id' });
  if (error) console.error('[auer-dult] upsert error', error);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

export default run;
