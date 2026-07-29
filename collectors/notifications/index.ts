import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { canonicalizeVenue } from '../core/canonicalizeVenue';

// Vorlaufzeiten sind jetzt pro Subscription wählbar (push_reminder_settings,
// siehe Migration 0010) statt fix — dieser Default greift nur, wenn eine
// Subscription (noch) keine eigene Einstellung gespeichert hat, und
// entspricht dem alten fest codierten Verhalten (3h vorher).
const DEFAULT_OFFSETS_MINUTES = [180];

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

// Ab wann eine Erinnerung eher das Datum ("Am 12.09 um 20:00 Uhr") als eine
// unmittelbare "beginnt bald"-Formulierung braucht — bei einer Vorlaufzeit
// von z.B. einem Monat wäre "Beginnt um 20:00 Uhr" ohne Datum irreführend.
const DATE_HINT_THRESHOLD_MINUTES = 20 * 60;

function reminderCopy(
  offsetMinutes: number,
  event: { start_date: string; start_time: string; title: string; location_name: string | null }
): { title: string; body: string } {
  const timeStr = event.start_time.slice(0, 5);
  const locationSuffix = event.location_name ? ` · ${event.location_name}` : '';
  if (offsetMinutes >= DATE_HINT_THRESHOLD_MINUTES) {
    const dateStr = new Date(`${event.start_date}T00:00:00`).toLocaleDateString('de-DE', {
      day: '2-digit',
      month: '2-digit',
    });
    return { title: `Erinnerung: ${event.title}`, body: `Am ${dateStr} um ${timeStr} Uhr${locationSuffix}` };
  }
  return { title: `Bald: ${event.title}`, body: `Beginnt um ${timeStr} Uhr${locationSuffix}` };
}

async function sendFavoriteReminders(supabase: ReturnType<typeof createClient>) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  const { data: rows, error } = await supabase
    .from('push_favorites')
    .select(
      'subscription_id, event_id, notified_offsets_minutes, ' +
      'push_subscriptions(endpoint,p256dh,auth), ' +
      'events!inner(id,title,start_date,start_time,location_name)'
    )
    .gte('events.start_date', today);

  if (error) { console.error('[notifications] favorite query error', error); return; }
  if (!rows || rows.length === 0) { console.log('[notifications] no pending favorite reminders'); return; }

  // Kein FK zwischen push_favorites und push_reminder_settings (beide
  // referenzieren push_subscriptions unabhängig voneinander) — PostgREST kann
  // das also nicht in der select()-Kette mit einbetten, separat laden und in
  // JS anhand subscription_id zuordnen.
  const { data: settingsRows, error: settingsError } = await supabase
    .from('push_reminder_settings')
    .select('subscription_id, offsets_minutes');
  if (settingsError) { console.error('[notifications] reminder settings query error', settingsError); return; }
  const offsetsBySubscription = new Map<string, number[]>(
    (settingsRows ?? []).map((r: any) => [r.subscription_id, r.offsets_minutes])
  );

  let sent = 0;
  for (const row of rows as any[]) {
    const event = row.events;
    const sub = row.push_subscriptions;
    if (!event || !sub) continue;

    // Kein start_time -> keine sinnvolle "beginnt bald"-Erinnerung möglich
    // (Ganztages-/Mehrtages-Events wie Ausstellungen), einfach überspringen.
    if (!event.start_time) continue;

    const configuredOffsets: number[] = offsetsBySubscription.get(row.subscription_id) ?? DEFAULT_OFFSETS_MINUTES;
    const alreadySent: number[] = row.notified_offsets_minutes ?? [];
    const eventStart = new Date(`${event.start_date}T${event.start_time}`);

    if (eventStart < now) {
      // Termin ist schon vorbei oder läuft bereits (z.B. weil der Job
      // zwischenzeitlich nicht lief) — alle Vorlaufzeiten als erledigt
      // markieren, damit künftige Läufe diese Zeile nicht mehr neu prüfen.
      if (alreadySent.length < configuredOffsets.length) {
        await supabase
          .from('push_favorites')
          .update({ notified_offsets_minutes: configuredOffsets })
          .match({ subscription_id: row.subscription_id, event_id: row.event_id });
      }
      continue;
    }

    // Welche konfigurierte, noch nicht verschickte Vorlaufzeit ist jetzt
    // erreicht? Läuft dieses Script z.B. alle 15 Minuten, reicht das, um
    // jede Vorlaufzeit genau einmal zu treffen, ohne dass sie "durchrutscht".
    const dueOffset = configuredOffsets
      .filter((minutes) => !alreadySent.includes(minutes))
      .find((minutes) => now.getTime() >= eventStart.getTime() - minutes * 60_000);
    if (dueOffset === undefined) continue; // noch nichts fällig, nächster Lauf prüft erneut

    const { title, body } = reminderCopy(dueOffset, event);
    const ok = await sendPush(supabase, sub, { title, body, url: `/event/${event.id}` });

    if (ok) {
      sent += 1;
      await supabase
        .from('push_favorites')
        .update({ notified_offsets_minutes: [...alreadySent, dueOffset] })
        .match({ subscription_id: row.subscription_id, event_id: row.event_id });
    }
  }
  console.log('[notifications] favorite reminders sent:', sent);
}

async function sendFilterMatches(supabase: ReturnType<typeof createClient>) {
  const { data: filterRows, error } = await supabase
    .from('push_filters')
    .select('subscription_id, categories, locations, organizers, last_checked_at, push_subscriptions(endpoint,p256dh,auth)');

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
    // "Veranstalter folgen" (nach dem Vorbild von Bandsintown/DICE): Notiz
    // wird als exakter Textabgleich gegen events.organizer geführt, so wie
    // der Name in der App vom Event übernommen wurde — keine Heuristik nötig.
    const organizers: string[] = filterRow.organizers ?? [];
    if (categories.length === 0 && locations.length === 0 && organizers.length === 0) continue;

    // Bei genau einem Kriterium kann direkt in SQL vorgefiltert werden. Sind
    // mehrere gesetzt (ODER-Semantik: irgendeins muss passen), muss breiter
    // geladen und in JS gefiltert werden — locations wird über
    // canonicalizeVenue() abgeglichen, einer clientseitigen Heuristik, die
    // sich nicht als SQL-Bedingung ausdrücken lässt.
    let query = supabase
      .from('events')
      .select('id, title, category, location_name, organizer, start_date')
      .gt('created_at', filterRow.last_checked_at)
      .is('duplicate_of', null)
      .gte('start_date', today)
      .limit(30);
    if (categories.length > 0 && locations.length === 0 && organizers.length === 0) {
      query = query.in('category', categories);
    }

    const { data: newEvents, error: evError } = await query;
    if (evError) { console.warn('[notifications] filter event query error', evError); continue; }

    const matches = (newEvents ?? []).filter(
      (e: any) =>
        (categories.length > 0 && categories.includes(e.category)) ||
        (locations.length > 0 && locations.includes(canonicalizeVenue(e.location_name))) ||
        (organizers.length > 0 && e.organizer && organizers.includes(e.organizer))
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
