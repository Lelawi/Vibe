import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import { getCoordinates } from '../../core/geocode';
import { fileURLToPath } from 'url';

/**
 * TicketTailor collector
 * - Prefer API if `TICKETTAILOR_API_KEY` is provided, otherwise fetch configured public listing pages.
 * - Env: `TICKETTAILOR_API_KEY`, `TICKETTAILOR_SEARCH_URLS`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
 */

export async function run() {
  console.log('[tickettailor] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.log('[tickettailor] missing Supabase envs — skipping');
    return;
  }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const urlsEnv = process.env.TICKETTAILOR_SEARCH_URLS ?? '';
  const urls = urlsEnv.split(',').map((s) => s.trim()).filter(Boolean);
  if (urls.length === 0) {
    // Ticket Tailor hat keine plattformweite Such-/Discovery-Seite (jeder
    // Veranstalter hat nur seine eigene "Box Office"-Seite) — ohne eine
    // konkrete Liste bekannter Münchner Box-Office-URLs gibt es nichts zu scrapen.
    console.log('[tickettailor] no TICKETTAILOR_SEARCH_URLS configured (no platform-wide search exists) — skipping');
    return;
  }

  const collected: any[] = [];
  const today = new Date().toISOString().slice(0, 10);

  for (const url of urls) {
    try {
      console.log('[tickettailor] fetching', url);
      const res = await fetch(url, { headers: { 'User-Agent': 'VibeApp-Collector/1.0' } });
      if (!res.ok) { console.warn('[tickettailor] fetch failed', res.status, url); continue; }
      const html = await res.text();
      const $ = cheerio.load(html);

      // Heuristic: look for JSON-LD or event cards
      const scripts = $('script[type="application/ld+json"]').toArray().map((el) => $(el).html()).filter(Boolean);
      for (const s of scripts) {
        try {
          const doc = JSON.parse(s!);
          if (doc['@type'] === 'Event') {
            const ev = doc;
            const name = ev.name ?? null;
            const start = ev.startDate ?? null;
            const location = ev.location ?? null;

            let location_name = null;
            let address = null;
            if (location) {
              location_name = location.name ?? null;
              if (location.address) {
                const a = location.address;
                address = [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode].filter(Boolean).join(', ');
              }
            }

            let start_date = null;
            let start_time = null;
            if (start) {
              const d = new Date(start);
              if (!isNaN(d.getTime())) {
                start_date = d.toISOString().slice(0,10);
                start_time = d.toISOString().slice(11,16);
              }
            }

            if (!start_date || start_date < today) continue;

            const sourceId = `tickettailor-${Buffer.from(String(ev.url ?? name ?? Math.random())).toString('base64').slice(0,20)}`;
            location_name = location_name ?? 'München';
            const coords = await getCoordinates(supabase, location_name, address, 'München');

            collected.push({
              source_id: sourceId,
              title: name ?? 'Unbenannt',
              description: ev.description ?? null,
              category: ev.eventType ?? 'Sonstiges',
              subcategory: null,
              start_date,
              start_time,
              location_name,
              address,
              city: 'München',
              organizer: ev.organizer?.name ?? null,
              source_url: ev.url ?? url,
              image_url: Array.isArray(ev.image) ? ev.image[0] : ev.image ?? null,
              latitude: coords?.latitude ?? null,
              longitude: coords?.longitude ?? null,
            });
          }
        } catch (e) {
          // ignore parse errors
        }
      }

      // fallback: look for event cards with minimal selectors
      $('.event-card, .search-result, .event').each((i, el) => {
        const el$ = $(el);
        const name = el$.find('.event-title, .title').first().text().trim() || null;
        const dateText = el$.find('.event-date, time').first().attr('datetime') || el$.find('.event-date').text().trim() || null;
        // Not attempting to extract all fields; JSON-LD is preferred
      });

      await new Promise((r) => setTimeout(r, 600));
    } catch (err) {
      console.warn('[tickettailor] error fetching', url, err);
    }
  }

  if (collected.length === 0) {
    console.log('[tickettailor] no events parsed');
    return;
  }

  console.log('[tickettailor] upserting', collected.length, 'events');
  const { error } = await supabase.from('events').upsert(collected, { onConflict: 'source_id' });
  if (error) console.error('[tickettailor] upsert error', error);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

export default run;
