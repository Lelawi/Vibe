import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';

// Push-Benachrichtigungen sind ausschließlich eine Web-/PWA-Funktion (Ziel-
// distribution laut CLAUDE.md ist die PWA, kein natives Push-Setup vorhanden)
// — auf iOS/Android-Native ist dieses Modul komplett inaktiv.
const SUBSCRIPTION_ID_KEY = 'vibe:push_subscription_id';

export function isPushSupported(): boolean {
  if (Platform.OS !== 'web') return false;
  if (typeof window === 'undefined') return false;
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function getPermissionState(): NotificationPermission | 'unsupported' {
  if (!isPushSupported()) return 'unsupported';
  return Notification.permission;
}

// VAPID-Public-Key kommt als base64url-String (wie von `web-push generate-
// vapid-keys` ausgegeben) und muss für die PushManager-API als Uint8Array
// vorliegen.
function urlBase64ToUint8Array(base64String: string): BufferSource {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0))) as BufferSource;
}

async function getCachedSubscriptionId(): Promise<string | null> {
  return AsyncStorage.getItem(SUBSCRIPTION_ID_KEY);
}

export async function isPushEnabled(): Promise<boolean> {
  return (await getCachedSubscriptionId()) !== null;
}

// Fordert Berechtigung an, abonniert den Browser-Push-Service und legt die
// Subscription in Supabase an. Die zurückgegebene subscription_id wird lokal
// gecacht, damit spätere App-Starts nicht erneut inserten (kein Update/Select-
// Recht auf push_subscriptions für anon, siehe Migration 0005 — ein zweiter
// Insert mit demselben endpoint würde am unique-Constraint scheitern).
export async function enablePushNotifications(): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isPushSupported()) return { ok: false, error: 'Push wird von diesem Browser nicht unterstützt.' };

  const vapidKey = process.env.EXPO_PUBLIC_VAPID_PUBLIC_KEY;
  if (!vapidKey) return { ok: false, error: 'Push ist serverseitig noch nicht konfiguriert.' };

  const cached = await getCachedSubscriptionId();
  if (cached) return { ok: true };

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, error: 'Berechtigung wurde nicht erteilt.' };

  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey),
    });
    const json = subscription.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
      return { ok: false, error: 'Subscription unvollständig.' };
    }

    // Id selbst generieren statt sie per .select() nach dem Insert
    // zurückzuholen: Postgres wendet auf die RETURNING-Zeile einer
    // .insert().select()-Anfrage auch SELECT-Policies an (nicht nur WITH
    // CHECK für den Insert selbst, wie ursprünglich angenommen) — und
    // push_subscriptions hat für anon absichtlich keine SELECT-Policy
    // (siehe Migration 0005). Das führte dazu, dass der reine Insert zwar
    // durchging, das RETURNING aber weiterhin an der RLS scheiterte. Mit
    // selbst erzeugter id brauchen wir gar kein RETURNING mehr.
    const id = crypto.randomUUID();
    const { error } = await supabase
      .from('push_subscriptions')
      .insert({ id, endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth });
    if (error) return { ok: false, error: error.message };

    await AsyncStorage.setItem(SUBSCRIPTION_ID_KEY, id);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Unbekannter Fehler.' };
  }
}

export async function disablePushNotifications(): Promise<void> {
  const subId = await getCachedSubscriptionId();
  await AsyncStorage.removeItem(SUBSCRIPTION_ID_KEY);
  if (!isPushSupported()) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    await subscription?.unsubscribe();
  } catch {
    // best effort — lokale Deaktivierung zählt auch ohne erfolgreichen
    // Browser-Unsubscribe, der Sender greift nur noch auf verwaiste Zeilen
    // zu, die beim nächsten Versandversuch mit einem 410 vom Push-Dienst
    // beantwortet und dann serverseitig aufgeräumt werden (siehe Sender).
  }
  // push_favorites/push_filters bleiben absichtlich stehen (fallen per
  // on-delete-cascade weg, sobald jemand die push_subscriptions-Zeile löscht
  // — das kann aktuell nur der Sender mit dem Service-Role-Key, siehe oben).
}

// Voll-Ersatz statt Diff: Favoritenlisten sind klein, ein Delete+Insert pro
// Änderung ist einfacher und robust genug für diese Größenordnung.
export async function syncFavoritesToServer(favoriteIds: string[]): Promise<void> {
  const subId = await getCachedSubscriptionId();
  if (!subId) return;
  await supabase.from('push_favorites').delete().eq('subscription_id', subId);
  if (favoriteIds.length > 0) {
    await supabase
      .from('push_favorites')
      .insert(favoriteIds.map((event_id) => ({ subscription_id: subId, event_id })));
  }
}

export async function syncReminderSettingsToServer(offsetsMinutes: number[]): Promise<void> {
  const subId = await getCachedSubscriptionId();
  if (!subId) return;
  await supabase
    .from('push_reminder_settings')
    .upsert({ subscription_id: subId, offsets_minutes: offsetsMinutes }, { onConflict: 'subscription_id' });
}

export async function syncFiltersToServer(filters: {
  categories: string[];
  genres: string[];
  locations: string[];
  organizers: string[];
}): Promise<void> {
  const subId = await getCachedSubscriptionId();
  if (!subId) return;
  const hasAnyFilter =
    filters.categories.length > 0 ||
    filters.genres.length > 0 ||
    filters.locations.length > 0 ||
    filters.organizers.length > 0;
  if (!hasAnyFilter) {
    await supabase.from('push_filters').delete().eq('subscription_id', subId);
    return;
  }
  await supabase.from('push_filters').upsert(
    { subscription_id: subId, ...filters },
    { onConflict: 'subscription_id' }
  );
}
