import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { canonicalizeVenue } from '../core/canonicalizeVenue';

// Wie weit im Voraus an ein favorisiertes Event erinnert wird. Läuft dieses
// Script z.B. alle 15 Minuten (siehe .github/workflows/send-notifications.yml),
// reicht ein 3h-Fenster, um jedes Event genau einmal zu treffen, ohne dass
// eine Erinnerung zwischen zwei Läufen "durchrutscht".
const REMINDER_WINDOW_MS = 3 * 60 * 60 * 1000;

async function sendPush(
  supabase: ReturnType<typeof createClient>,
  sub: { endpoint: string; p256dh: string; auth: string },
  payload: { title: string; body: string; url: string }
): Promise<boolean> {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload)
    );
    return true;
  } catch (err: any) {
    if (err?.statusCode === 404 || err?.statusCode === 410) {
      // Push-Dienst kennt diese Subscription nicht mehr (Browser abgemeldet,
      // Website-Daten gelöscht etc.) — Zeile aufräumen, sonst schlägt jeder
      // künftige Lauf wieder für dieselbe tote Subscription fehl.
      await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
    } else {
      console.warn('[notifications] send failed', err?.statusCode, err?.body ?? err);
    }
    return false;
  }
}

async function sendFavoriteReminders(supabase: ReturnType<typeof createClient>) {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + REMINDER_WINDOW_MS);

  const { data: rows, error } = await supabase
    .from('push_favorites')
    .select('subscription_id, event_id, push_subscriptions(endpoint,p256dh,auth), events(id,title,start_date,start_time,location_name)')
    .is('notified_at', null);

  if (error) { console.error('[notifications] favorite query error', error); return; }
  if (!rows || rows.length === 0) { console.log('[notifications] no pending favorite reminders'); return; }

  let sent = 0;
  for (const row of rows as any[]) {
    const event = row.events;
    const sub = row.push_subscriptions;
    if (!event || !sub) continue;

    // Kein start_time -> keine sinnvolle "beginnt bald"-Erinnerung möglich
    // (Ganztages-/Mehrtages-Events wie Ausstellungen), einfach überspringen.
    if (!event.start_time) continue;

    const eventStart = new Date(`${event.start_date}T${event.start_time}`);

    if (eventStart < now) {
      // Termin ist schon vorbei oder läuft bereits (verpasstes Fenster,
      // z.B. weil der Job zwischenzeitlich nicht lief) — nicht mehr
      // relevant, nur noch als erledigt markieren statt jeden Lauf neu zu prüfen.
      await supabase
        .from('push_favorites')
        .update({ notified_at: now.toISOString() })
        .match({ subscription_id: row.subscription_id, event_id: row.event_id });
      continue;
    }
    if (eventStart > windowEnd) continue; // noch zu weit weg, nächster Lauf prüft erneut

    const ok = await sendPush(supabase, sub, {
      title: `Bald: ${event.title}`,
      body: `Beginnt um ${event.start_time.slice(0, 5)} Uhr${event.location_name ? ' · ' + event.location_name : ''}`,
      url: `/event/${event.id}`,
    });

    if (ok) {
      sent += 1;
      await supabase
        .from('push_favorites')
        .update({ notified_at: now.toISOString() })
        .match({ subscription_id: row.subscription_id, event_id: row.event_id });
    }
  }
  console.log('[notifications] favorite reminders sent:', sent);
}

async function sendFilterMatches(supabase: ReturnType<typeof createClient>) {
  const { data: filterRows, error } = await supabase
    .from('push_filters')
    .select('subscription_id, categories, locations, last_checked_at, push_subscriptions(endpoint,p256dh,auth)');

  if (error) { console.error('[notifications] filter query error', error); return; }
  if (!filterRows || filterRows.length === 0) { console.log('[notifications] no active filter subscriptions'); return; }

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  let sent = 0;

  for (const filterRow of filterRows as any[]) {
    const sub = filterRow.push_subscriptions;
    if (!sub) continue;
    const categories: string[] = filterRow.categories ?? [];
    const locations: string[] = filterRow.locations ?? [];
    if (categories.length === 0 && locations.length === 0) continue;

    // Bei genau einem Kriterium kann direkt in SQL vorgefiltert werden. Sind
    // beide gesetzt (ODER-Semantik: Kategorie ODER Ort passt), muss breiter
    // geladen und in JS gefiltert werden — locations wird über
    // canonicalizeVenue() abgeglichen, einer clientseitigen Heuristik, die
    // sich nicht als SQL-Bedingung ausdrücken lässt.
    let query = supabase
      .from('events')
      .select('id, title, category, location_name, start_date')
      .gt('created_at', filterRow.last_checked_at)
      .is('duplicate_of', null)
      .gte('start_date', today)
      .limit(30);
    if (categories.length > 0 && locations.length === 0) {
      query = query.in('category', categories);
    }

    const { data: newEvents, error: evError } = await query;
    if (evError) { console.warn('[notifications] filter event query error', evError); continue; }

    const matches = (newEvents ?? []).filter(
      (e: any) =>
        (categories.length > 0 && categories.includes(e.category)) ||
        (locations.length > 0 && locations.includes(canonicalizeVenue(e.location_name)))
    );

    if (matches.length > 0) {
      const first = matches[0];
      const title = matches.length === 1 ? `Neu: ${first.title}` : `${matches.length} neue Events für dich`;
      const body =
        matches.length === 1
          ? first.location_name || 'Passt zu deinen gespeicherten Filtern'
          : matches.slice(0, 3).map((m: any) => m.title).join(', ');
      const ok = await sendPush(supabase, sub, {
        title,
        body,
        url: matches.length === 1 ? `/event/${first.id}` : '/',
      });
      if (ok) sent += 1;
    }

    await supabase
      .from('push_filters')
      .update({ last_checked_at: now.toISOString() })
      .eq('subscription_id', filterRow.subscription_id);
  }
  console.log('[notifications] filter-match notifications sent:', sent);
}

export async function run() {
  console.log('[notifications] starting');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT;
  if (!supabaseUrl || !supabaseKey) { console.log('[notifications] missing supabase envs — skipping'); return; }
  if (!vapidPublic || !vapidPrivate || !vapidSubject) { console.log('[notifications] missing VAPID envs — skipping'); return; }

  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
  const supabase = createClient(supabaseUrl, supabaseKey);

  await sendFavoriteReminders(supabase);
  await sendFilterMatches(supabase);
  console.log('[notifications] finished');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}

export default run;
