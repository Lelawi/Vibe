import { Platform, Linking } from 'react-native';

// iOS Safari öffnet bei window.open(...) aus einer installierten Standalone-
// PWA gelegentlich nur einen leeren neuen Tab statt zur Ziel-URL zu
// navigieren (per Nutzer-Screenshot gemeldet: leere Safari-Adressleiste
// statt z.B. Google Maps) — ein bekannter WebKit-Effekt bei scripted
// window.open()-Aufrufen aus einem Standalone-Kontext heraus (siehe auch die
// verwandte, bereits gefixte "eingefrorene PWA beim Zurückwechseln"-Baustelle
// in _layout.tsx). Ein programmatischer Klick auf ein <a>-Element läuft über
// den normalen Link-Navigationspfad des Browsers statt über die Popup-API
// und umgeht das zuverlässiger als Linking.openURL (react-native-web ruft
// darin intern ebenfalls nur window.open auf).
export function openExternalUrl(url: string): void {
  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    return;
  }
  Linking.openURL(url);
}
