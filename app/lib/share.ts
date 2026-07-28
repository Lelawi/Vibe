import { Platform, Share } from 'react-native';

export type ShareResult = 'shared' | 'copied' | 'unsupported' | 'cancelled';

// Web: Web Share API (öffnet das native Teilen-Menü auf Handys), mit
// Zwischenablage-Kopie als Fallback für Browser ohne Unterstützung (v.a.
// Desktop). Kein window.alert() als Feedback — das ist im installierten
// PWA-Standalone-Modus auf iOS deaktiviert (gleiches Problem wie beim
// Datums-Picker), Rückmeldung übernimmt stattdessen der aufrufende Screen.
export async function shareEvent(title: string, fallbackUrl: string | null): Promise<ShareResult> {
  if (Platform.OS === 'web') {
    const url = typeof window !== 'undefined' ? window.location.href : fallbackUrl ?? '';
    if (typeof navigator !== 'undefined' && 'share' in navigator) {
      try {
        await (navigator as unknown as { share: (data: { title: string; url: string }) => Promise<void> }).share({ title, url });
        return 'shared';
      } catch {
        return 'cancelled';
      }
    }
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(url);
      return 'copied';
    }
    return 'unsupported';
  }

  if (!fallbackUrl) return 'unsupported';
  try {
    await Share.share({ message: `${title} — ${fallbackUrl}`, url: fallbackUrl });
    return 'shared';
  } catch {
    return 'cancelled';
  }
}
