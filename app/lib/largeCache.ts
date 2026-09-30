import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

// Speicher für die großen Offline-Caches (Eventliste ~4,8 Mio. Zeichen,
// Venue-Listen zusammen ~2,7 Mio.). AsyncStorage schreibt im Web nach
// localStorage, dessen Kontingent (~5 MB pro Origin) diese Caches allein
// schon sprengen — und ist localStorage voll, scheitern auch die kleinen,
// wichtigen Writes wie Favoriten oder die Push-Subscription-ID (Fund
// 2026-09-30). Im Web deshalb IndexedDB (Kontingent im Bereich von
// Hunderten MB, speichert Objekte ohne JSON.stringify), nativ weiter
// AsyncStorage.

const DB_NAME = 'vibe-cache';
const STORE = 'kv';
// Älterer Stand wird verworfen statt als "aktuell" angezeigt.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type Envelope<T> = { savedAt: number; value: T };

const useIndexedDb = Platform.OS === 'web' && typeof indexedDB !== 'undefined';

let dbPromise: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

function idbRequest<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = run(tx.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}

// Früher lagen die Caches unter demselben Key in localStorage — dort einmalig
// entfernen, damit das Kontingent wieder für die kleinen Stores frei wird.
const legacyCleaned = new Set<string>();
function cleanLegacy(key: string) {
  if (!useIndexedDb || legacyCleaned.has(key)) return;
  legacyCleaned.add(key);
  AsyncStorage.removeItem(key).catch(() => {});
}

export async function getLargeCache<T>(key: string): Promise<T | null> {
  try {
    let envelope: Envelope<T> | undefined;
    if (useIndexedDb) {
      cleanLegacy(key);
      envelope = await idbRequest<Envelope<T> | undefined>('readonly', (s) => s.get(key));
    } else {
      const raw = await AsyncStorage.getItem(key);
      envelope = raw ? JSON.parse(raw) : undefined;
    }
    if (!envelope || typeof envelope.savedAt !== 'number') return null;
    if (Date.now() - envelope.savedAt > MAX_AGE_MS) return null;
    return envelope.value;
  } catch {
    // Kaputter/fehlender Cache ist unkritisch — die Daten kommen ohnehin
    // frisch aus Supabase, nur ohne Sofort-Anzeige.
    return null;
  }
}

export async function setLargeCache(key: string, value: unknown): Promise<void> {
  const envelope: Envelope<unknown> = { savedAt: Date.now(), value };
  try {
    if (useIndexedDb) {
      cleanLegacy(key);
      await idbRequest('readwrite', (s) => s.put(envelope, key));
    } else {
      await AsyncStorage.setItem(key, JSON.stringify(envelope));
    }
  } catch {
    // Speicher voll o.ä. — unkritisch, nur ohne Disk-Cache beim nächsten
    // echten Neuladen.
  }
}
