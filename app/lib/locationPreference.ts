import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';
import type { PostalCodeLocation } from './postalCodes';

// Woher der "Nähe"-Filter seinen Standort nimmt — per Nutzer-Hinweis
// (2026-10-12): man soll ihn auch ohne Standortfreigabe nutzen können, indem
// man eine PLZ eingibt. null = noch nicht gewählt (beim ersten Tippen auf
// "Nähe" öffnet sich die Auswahl), 'gps' = Browser-Standort wie bisher,
// 'postalCode' = fester Mittelpunkt der eingegebenen PLZ, ganz ohne
// Standortabfrage — gilt dann auch für den "Wo bin ich"-Punkt der Karten.
export type LocationPreference =
  | { mode: 'gps' }
  | ({ mode: 'postalCode' } & PostalCodeLocation);

export type LatLng = { lat: number; lng: number };

// Gleiches Cache+Pub/Sub-Muster wie favorites.ts — Eventliste, Venue-Listen,
// Karten und Einstellungen sehen ohne gemeinsamen Provider denselben Stand.
const STORAGE_KEY = 'vibe:locationPreference';

let cache: LocationPreference | null = null;
let loaded = false;
const listeners = new Set<(pref: LocationPreference | null) => void>();

export async function loadLocationPreference(): Promise<LocationPreference | null> {
  if (loaded) return cache;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed?.mode === 'gps') cache = { mode: 'gps' };
    else if (
      parsed?.mode === 'postalCode' &&
      typeof parsed.postalCode === 'string' &&
      typeof parsed.lat === 'number' &&
      typeof parsed.lng === 'number'
    ) {
      cache = parsed;
    }
  } catch {
    // Kaputtes/altes Format oder kein Zugriff auf den Speicher -> nicht gewählt.
  }
  loaded = true;
  return cache;
}

export async function setLocationPreference(pref: LocationPreference | null) {
  cache = pref;
  loaded = true;
  // Erst die UI aktualisieren, dann speichern (siehe favorites.ts).
  listeners.forEach((l) => l(pref));
  try {
    if (pref) await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(pref));
    else await AsyncStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.warn('[locationPreference] Speichern fehlgeschlagen', err);
  }
}

export function useLocationPreference() {
  const [preference, setPreference] = useState<LocationPreference | null>(cache);

  useEffect(() => {
    let mounted = true;
    loadLocationPreference().then((pref) => {
      if (mounted) setPreference(pref);
    });
    const listener = (pref: LocationPreference | null) => setPreference(pref);
    listeners.add(listener);
    return () => {
      mounted = false;
      listeners.delete(listener);
    };
  }, []);

  return { preference, setPreference: setLocationPreference };
}

export function canUseGps(): boolean {
  return Platform.OS === 'web' && typeof navigator !== 'undefined' && !!navigator.geolocation;
}

export function getGpsPosition(): Promise<LatLng> {
  return new Promise((resolve, reject) => {
    if (!canUseGps()) {
      reject(new Error('geolocation unavailable'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      reject,
      { enableHighAccuracy: false, timeout: 10000 }
    );
  });
}

// Für die Karten: bei gesetzter PLZ deren Mittelpunkt, sonst best-effort der
// Browser-Standort wie bisher (null bei Ablehnung, kein Fehler-UI).
export async function resolveMapUserLocation(): Promise<LatLng | null> {
  const pref = await loadLocationPreference();
  if (pref?.mode === 'postalCode') return { lat: pref.lat, lng: pref.lng };
  try {
    return await getGpsPosition();
  } catch {
    return null;
  }
}

// Gemeinsame Logik des "Nähe"-Buttons der Eventliste und der Venue-Listen
// (vorher zweimal identisch inline als toggleNearby). Der Filter selbst ist
// wie bisher nicht persistiert — nur die Standort-Quelle wird gemerkt, damit
// man die PLZ nicht bei jedem Antippen neu eingeben muss.
export function useNearbyLocation() {
  const { preference } = useLocationPreference();
  const [active, setActive] = useState(false);
  const [gpsLocation, setGpsLocation] = useState<LatLng | null>(null);
  const [locationStatus, setLocationStatus] = useState<'idle' | 'loading' | 'denied'>('idle');
  const [pickerVisible, setPickerVisible] = useState(false);

  // Memoisiert, weil die Listen userLocation als useMemo-Abhängigkeit fürs
  // Sortieren/Filtern tausender Einträge nutzen — ein bei jedem Render neues
  // Objekt hätte das bei jedem Render neu rechnen lassen.
  const postalLat = preference?.mode === 'postalCode' ? preference.lat : null;
  const postalLng = preference?.mode === 'postalCode' ? preference.lng : null;
  const userLocation = useMemo<LatLng | null>(() => {
    if (!active) return null;
    if (postalLat !== null && postalLng !== null) return { lat: postalLat, lng: postalLng };
    return gpsLocation;
  }, [active, postalLat, postalLng, gpsLocation]);

  async function requestGps() {
    setLocationStatus('loading');
    try {
      setGpsLocation(await getGpsPosition());
      setLocationStatus('idle');
      setActive(true);
    } catch {
      // Abgelehnt/nicht verfügbar -> direkt die PLZ-Eingabe als Alternative
      // anbieten, statt nur einen Hinweis anzuzeigen.
      setLocationStatus('denied');
      setActive(false);
      setPickerVisible(true);
    }
  }

  async function toggleNearby() {
    if (userLocation) {
      setActive(false);
      setLocationStatus('idle');
      return;
    }
    const pref = await loadLocationPreference();
    if (pref?.mode === 'postalCode') {
      setLocationStatus('idle');
      setActive(true);
    } else if (pref?.mode === 'gps') {
      await requestGps();
    } else {
      setPickerVisible(true);
    }
  }

  // Wechselt jemand woanders (z.B. in den Einstellungen) von PLZ auf GPS,
  // während der Filter hier aktiv ist, fehlt noch eine GPS-Position.
  useEffect(() => {
    if (active && preference?.mode === 'gps' && !gpsLocation && locationStatus === 'idle') requestGps();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, preference, gpsLocation]);

  function chooseGps() {
    setPickerVisible(false);
    // Erst die Abfrage starten (setzt synchron 'loading'), dann die Quelle
    // umstellen — sonst stößt der Effekt oben eine zweite Abfrage an.
    const request = requestGps();
    setLocationPreference({ mode: 'gps' });
    return request;
  }

  async function choosePostalCode(location: PostalCodeLocation) {
    setPickerVisible(false);
    await setLocationPreference({ mode: 'postalCode', ...location });
    setLocationStatus('idle');
    setActive(true);
  }

  return {
    userLocation,
    locationStatus,
    preference,
    toggleNearby,
    clearNearby: () => {
      setActive(false);
      setLocationStatus('idle');
    },
    openPicker: () => setPickerVisible(true),
    pickerProps: {
      visible: pickerVisible,
      onClose: () => setPickerVisible(false),
      onUseGps: chooseGps,
      onUsePostalCode: choosePostalCode,
      preference,
      gpsDenied: locationStatus === 'denied',
    },
  };
}
