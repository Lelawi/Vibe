import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { canonicalizeVenue } from '../core/canonicalizeVenue';
import { normalizeGenreGroup } from '../core/genreGroup';
import { matchesSavedSearch, type SavedSearchCriteria } from '../core/savedSearchFilter';

// Vorlaufzeiten sind jetzt pro Subscription wählbar (push_reminder_settings,
// siehe Migration 0010) statt fix — dieser Default greift nur, wenn eine
// Subscription (noch) keine eigene Einstellung gespeichert hat, und
// entspricht dem alten fest codierten Verhalten (3h vorher).
const DEFAULT_OFFSETS_MINUTES = [180];

// Die PWA liegt nicht auf der Domain-Wurzel, sondern unter /Vibe (GitHub
// Pages Project-Site, siehe experiments.baseUrl in app/app.json und die
// Service-Worker-Registrierung in app/app/_layout.tsx). Ein root-relativer
// Klick-Link wie "/event/123" (ohne dieses Präfix) resolved im Service
// Worker gegen die Domain-Wurzel, nicht gegen den App-Unterordner, und
// landet auf GitHub Pages' generischer 404-Seite statt in der App (per
// Nutzer-Feedback entdeckt, 2026-08-11). Alle hier gebauten Notification-
// URLs müssen deshalb mit diesem Präfix beginnen.
const APP_BASE_PATH = '/Vibe';

function berlinDate(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

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
    const ok = await sendPush(supabase, sub, { title, body, url: `${APP_BASE_PATH}/event/${event.id}` });

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
    .select('subscription_id, categories, genres, locations, organizers, last_checked_at, push_subscriptions(endpoint,p256dh,auth)');

  if (error) { console.error('[notifications] filter query error', error); return; }
  if (!filterRows || filterRows.length === 0) { console.log('[notifications] no active filter subscriptions'); return; }

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  let sent = 0;

  for (const filterRow of filterRows as any[]) {
    const sub = filterRow.push_subscriptions;
    if (!sub) continue;
    const categories: string[] = filterRow.categories ?? [];
    // Genre-Gruppen (z.B. "Pop & Rock") wurden vom Client schon lange
    // mitgeschickt, aber hier nie ausgewertet — normalizeGenreGroup() ist
    // dieselbe Heuristik wie in der App (app/app/index.tsx), 1:1 kopiert nach
    // core/genreGroup.ts, da Collectors nicht aus app/ importieren dürfen.
    const genres: string[] = filterRow.genres ?? [];
    const locations: string[] = filterRow.locations ?? [];
    // "Veranstalter folgen" (nach dem Vorbild von Bandsintown/DICE): Notiz
    // wird als exakter Textabgleich gegen events.organizer geführt, so wie
    // der Name in der App vom Event übernommen wurde — keine Heuristik nötig.
    const organizers: string[] = filterRow.organizers ?? [];
    if (categories.length === 0 && genres.length === 0 && locations.length === 0 && organizers.length === 0) continue;

    // Bestehende Installationen behalten diesen Legacy-Filter, aber auch hier
    // gilt jetzt: ODER innerhalb einer Dimension, UND zwischen Dimensionen.
    let query = supabase
      .from('events')
      .select('id, title, category, subcategory, location_name, organizer, start_date, end_date')
      .gt('created_at', filterRow.last_checked_at)
      .is('duplicate_of', null)
      .or(`start_date.gte.${today},end_date.gte.${today}`)
      .limit(500);
    if (categories.length > 0 && genres.length === 0 && locations.length === 0 && organizers.length === 0) {
      query = query.in('category', categories);
    }

    const { data: newEvents, error: evError } = await query;
    if (evError) { console.warn('[notifications] filter event query error', evError); continue; }

    const matches = (newEvents ?? []).filter(
      (e: any) =>
        (categories.length === 0 || categories.includes(e.category)) &&
        (genres.length === 0 || genres.includes(normalizeGenreGroup(e.subcategory ?? e.category))) &&
        (locations.length === 0 || locations.includes(canonicalizeVenue(e.location_name))) &&
        (organizers.length === 0 || Boolean(e.organizer && organizers.includes(e.organizer)))
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
        url: matches.length === 1 ? `${APP_BASE_PATH}/event/${first.id}` : `${APP_BASE_PATH}/`,
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

async function sendSavedSearchMatches(supabase: ReturnType<typeof createClient>) {
  const { data: rows, error } = await supabase
    .from('push_saved_searches')
    .select('id,subscription_id,name,categories,genres,locations,date_filter,free_only,available_only,last_checked_at,push_subscriptions(endpoint,p256dh,auth)')
    .eq('enabled', true);
  if (error) { console.error('[notifications] saved-search query error', error); return; }
  if (!rows || rows.length === 0) return;

  const now = new Date();
  const today = berlinDate(now);
  let sent = 0;
  for (const row of rows as any[]) {
    const sub = row.push_subscriptions;
    if (!sub) continue;
    const criteria: SavedSearchCriteria = {
      categories: row.categories ?? [],
      genres: row.genres ?? [],
      locations: row.locations ?? [],
      dateFilter: row.date_filter ?? 'all',
      freeOnly: row.free_only ?? false,
      availableOnly: row.available_only ?? true,
    };
    const { data: events, error: eventError } = await supabase
      .from('events')
      .select('id,title,category,subcategory,location_name,start_date,end_date,price_info,sold_out')
      .gt('created_at', row.last_checked_at)
      .is('duplicate_of', null)
      .or(`start_date.gte.${today},end_date.gte.${today}`)
      .order('start_date', { ascending: true })
      .limit(500);
    if (eventError) { console.warn('[notifications] saved-search event query error', eventError); continue; }

    const matches = (events ?? []).filter((event: any) => matchesSavedSearch(event, criteria, today));
    if (matches.length > 0) {
      const first = matches[0];
      const ok = await sendPush(supabase, sub, {
        title: matches.length === 1 ? `Neu in „${row.name}“` : `${matches.length} neue Treffer: ${row.name}`,
        body: matches.length === 1
          ? `${first.title}${first.location_name ? ` · ${first.location_name}` : ''}`
          : matches.slice(0, 3).map((event: any) => event.title).join(', '),
        url: matches.length === 1 ? `${APP_BASE_PATH}/event/${first.id}` : `${APP_BASE_PATH}/`,
      });
      if (ok) sent += 1;
    }
    await supabase.from('push_saved_searches').update({ last_checked_at: now.toISOString() }).eq('id', row.id);
  }
  console.log('[notifications] saved-search notifications sent:', sent);
}

async function sendArtistMatches(supabase: ReturnType<typeof createClient>) {
  const { data: follows, error } = await supabase
    .from('push_artist_follows')
    .select('subscription_id,artist_id,last_checked_at,push_subscriptions(endpoint,p256dh,auth),artists(display_name)');
  if (error) { console.error('[notifications] artist-follow query error', error); return; }
  if (!follows || follows.length === 0) return;
  const now = new Date().toISOString();
  const today = berlinDate();
  let sent = 0;
  for (const follow of follows as any[]) {
    const { data: links, error: linkError } = await supabase
      .from('event_artists').select('event_id').eq('artist_id', follow.artist_id).gt('created_at', follow.last_checked_at);
    if (linkError) { console.warn('[notifications] artist event-link query error', linkError); continue; }
    const ids = [...new Set((links ?? []).map((link: any) => link.event_id as string))];
    if (ids.length > 0 && follow.push_subscriptions) {
      const { data: events, error: eventError } = await supabase
        .from('events').select('id,title,start_date,end_date,location_name').in('id', ids)
        .is('duplicate_of', null).or(`start_date.gte.${today},end_date.gte.${today}`).order('start_date');
      if (eventError) { console.warn('[notifications] artist event query error', eventError); continue; }
      if (events && events.length > 0) {
        const first: any = events[0];
        const name = follow.artists?.display_name ?? 'gefolgtem Künstler';
        const ok = await sendPush(supabase, follow.push_subscriptions, {
          title: `Neues Event von ${name}`,
          body: `${first.title}${first.location_name ? ` · ${first.location_name}` : ''}`,
          url: `${APP_BASE_PATH}/event/${first.id}`,
        });
        if (ok) sent += 1;
      }
    }
    await supabase.from('push_artist_follows').update({ last_checked_at: now })
      .match({ subscription_id: follow.subscription_id, artist_id: follow.artist_id });
  }
  console.log('[notifications] artist notifications sent:', sent);
}

async function sendFavoriteChanges(supabase: ReturnType<typeof createClient>) {
  const { data: changes, error } = await supabase
    .from('event_changes')
    .select('id,event_id,changed_fields,new_values,events(title)')
    .is('notified_at', null)
    .order('created_at', { ascending: true })
    .limit(100);
  if (error) { console.error('[notifications] event-change query error', error); return; }
  if (!changes || changes.length === 0) return;
  let sent = 0;
  const labels: Record<string, string> = {
    start_date: 'Datum', start_time: 'Uhrzeit', end_date: 'Enddatum', location_name: 'Ort',
    address: 'Adresse', price_info: 'Preis', sold_out: 'Verfügbarkeit', source_url: 'Ticketlink',
  };
  for (const change of changes as any[]) {
    const { data: favorites, error: favoriteError } = await supabase
      .from('push_favorites')
      .select('push_subscriptions(endpoint,p256dh,auth)')
      .eq('event_id', change.event_id);
    if (favoriteError) { console.warn('[notifications] changed favorite query error', favoriteError); continue; }
    const fields = (change.changed_fields as string[]).map((field) => labels[field] ?? field).join(', ');
    const cancelled = change.changed_fields.includes('sold_out') && change.new_values?.sold_out === true;
    for (const favorite of (favorites ?? []) as any[]) {
      if (!favorite.push_subscriptions) continue;
      const ok = await sendPush(supabase, favorite.push_subscriptions, {
        title: cancelled ? `Nicht mehr verfügbar: ${change.events?.title}` : `Event aktualisiert: ${change.events?.title}`,
        body: cancelled ? 'Der Anbieter meldet dieses Event als ausverkauft oder nicht verfügbar.' : `Geändert: ${fields}`,
        url: `${APP_BASE_PATH}/event/${change.event_id}`,
      });
      if (ok) sent += 1;
    }
    await supabase.from('event_changes').update({ notified_at: new Date().toISOString() }).eq('id', change.id);
  }
  console.log('[notifications] favorite change notifications sent:', sent);
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
  await sendSavedSearchMatches(supabase);
  await sendArtistMatches(supabase);
  await sendFavoriteChanges(supabase);
  console.log('[notifications] finished');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}

export default run;
