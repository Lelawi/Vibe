import { createClient } from '@supabase/supabase-js';
import { getCoordinates } from '../../core/geocode';
import { fileURLToPath } from 'url';

/**
 * Facebook Events collector — NICHT in collect-all.ts / im Workflow eingebunden,
 * da kein FACEBOOK_ACCESS_TOKEN / keine FACEBOOK_PAGE_IDS konfiguriert sind.
 * Benötigt eine Facebook-App + Page-Access-Token pro zu beobachtender Seite.
 * Env: `FACEBOOK_ACCESS_TOKEN`, `FACEBOOK_PAGE_IDS`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
 */

export async function run() {
  console.log('[facebook-events] starting');
  const token = process.env.FACEBOOK_ACCESS_TOKEN;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!token || !supabaseUrl || !supabaseKey) {
    console.log('[facebook-events] missing FACEBOOK_ACCESS_TOKEN or Supabase envs — skipping');
    return;
  }

  const pageIdsEnv = process.env.FACEBOOK_PAGE_IDS ?? '';
  const pageIds = pageIdsEnv.split(',').map((s) => s.trim()).filter(Boolean);
  if (pageIds.length === 0) {
    console.log('[facebook-events] no FACEBOOK_PAGE_IDS provided — skipping');
    return;
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  const collected: any[] = [];

  for (const pageId of pageIds) {
    try {
      console.log('[facebook-events] fetching events for page', pageId);
      const url = `https://graph.facebook.com/v17.0/${pageId}/events?access_token=${token}&time_filter=upcoming&limit=100`;
      const res = await fetch(url);
      if (!res.ok) { console.warn('[facebook-events] fetch failed', res.status); continue; }
      const body = await res.json();
      const events = body.data ?? [];
      for (const ev of events) {
        const id = ev.id;
        const name = ev.name ?? 'Unbenannt';
        const start = ev.start_time ?? ev.start_time;
        let start_date = null;
        let start_time = null;
        if (start) {
          const d = new Date(start);
          if (!isNaN(d.getTime())) {
            start_date = d.toISOString().slice(0,10);
            start_time = d.toISOString().slice(11,16);
          }
        }

        const location_name = ev.place?.name ?? null;
        const address = ev.place?.location ? [ev.place.location.street, ev.place.location.city, ev.place.location.region, ev.place.location.postal_code].filter(Boolean).join(', ') : null;

        const coords = await getCoordinates(supabase, location_name ?? name, address, 'München');

        collected.push({
          source_id: `facebook-${id}`,
          title: name,
          description: ev.description ?? null,
          category: null,
          subcategory: null,
          start_date,
          start_time,
          location_name,
          address,
          city: 'München',
          organizer: pageId,
          source_url: ev.ticket_uri ?? ev.event_url ?? null,
          image_url: null,
          latitude: coords?.latitude ?? null,
          longitude: coords?.longitude ?? null,
        });
      }
    } catch (err) {
      console.warn('[facebook-events] error for', pageId, err);
    }
    await new Promise((r) => setTimeout(r, 600));
  }

  if (collected.length) {
    console.log('[facebook-events] upserting', collected.length, 'events');
    const { error } = await supabase.from('events').upsert(collected, { onConflict: 'source_id' });
    if (error) console.error('[facebook-events] upsert error', error);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

export default run;
