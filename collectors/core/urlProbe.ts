import dns from 'node:dns/promises';
import net from 'node:net';

export type UrlProbe = {
  outcome: 'reachable' | 'gone' | 'unclear' | 'blocked';
  url: string;
  finalUrl?: string;
  status?: number;
  reason: string;
};

export function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const parts = address.split('.').map(Number);
    return parts[0] === 10
      || parts[0] === 127
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)
      || parts[0] === 0;
  }
  const normalized = address.toLowerCase();
  return normalized === '::1'
    || normalized === '::'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe8')
    || normalized.startsWith('fe9')
    || normalized.startsWith('fea')
    || normalized.startsWith('feb');
}

async function assertPublicTarget(url: URL): Promise<void> {
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Nur HTTP(S)-URLs sind erlaubt');
  if (url.hostname === 'localhost' || url.hostname.endsWith('.local')) throw new Error('Lokale Ziele sind gesperrt');
  if (net.isIP(url.hostname) && isPrivateAddress(url.hostname)) throw new Error('Private IP-Ziele sind gesperrt');
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) throw new Error('Private DNS-Ziele sind gesperrt');
}

async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = maxBytes - size;
    const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
    chunks.push(chunk);
    size += chunk.byteLength;
    if (value.byteLength > remaining) break;
  }
  await reader.cancel().catch(() => undefined);
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

export async function probePublicUrl(input: string): Promise<UrlProbe> {
  let current: URL;
  try { current = new URL(input); } catch { return { outcome: 'unclear', url: input, reason: 'Ungueltige URL' }; }
  for (let redirect = 0; redirect <= 5; redirect++) {
    try {
      await assertPublicTarget(current);
      const response = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': 'Vibe-Feedback-Precheck/1.0', Accept: 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(15_000),
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) return { outcome: 'unclear', url: input, status: response.status, reason: 'Weiterleitung ohne Ziel' };
        current = new URL(location, current);
        continue;
      }
      if (response.status >= 200 && response.status < 400) {
        return { outcome: 'reachable', url: input, finalUrl: current.toString(), status: response.status, reason: 'Website erreichbar' };
      }
      if (response.status === 410) return { outcome: 'gone', url: input, finalUrl: current.toString(), status: 410, reason: 'HTTP 410 Gone' };
      return { outcome: 'unclear', url: input, finalUrl: current.toString(), status: response.status, reason: `HTTP ${response.status}` };
    } catch (error) {
      const err = error as Error & { code?: string; cause?: { code?: string } };
      const code = err.code ?? err.cause?.code;
      if (code === 'ENOTFOUND' || code === 'ENODATA') return { outcome: 'gone', url: input, reason: `DNS ${code}` };
      if (/Private|Lokale|HTTP\(S\)/.test(err.message)) return { outcome: 'blocked', url: input, reason: err.message };
      return { outcome: 'unclear', url: input, reason: err.message };
    }
  }
  return { outcome: 'unclear', url: input, reason: 'Zu viele Weiterleitungen' };
}

// Holt nur den <title>-Text einer Seite, ohne den Rest wie
// fetchPublicPageText() zu Fliesstext zu verstuemmeln — gebraucht, um den
// tatsaechlichen Geschaeftsnamen einer Venue-Website zu ermitteln, wenn der
// hinterlegte (oft von OSM uebernommene) Name bei Google Places keinen
// Treffer liefert. Siehe resolvePlaceCandidateByWebsiteTitle().
export async function fetchPageTitle(input: string, maxBytes = 20_000): Promise<{ probe: UrlProbe; title: string | null }> {
  let current: URL;
  try { current = new URL(input); } catch { return { probe: { outcome: 'unclear', url: input, reason: 'Ungueltige URL' }, title: null }; }
  for (let redirect = 0; redirect <= 5; redirect++) {
    try {
      await assertPublicTarget(current);
      const response = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': 'Vibe-Feedback-Precheck/1.0', Accept: 'text/html' },
        signal: AbortSignal.timeout(15_000),
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) return { probe: { outcome: 'unclear', url: input, status: response.status, reason: 'Weiterleitung ohne Ziel' }, title: null };
        current = new URL(location, current);
        continue;
      }
      if (response.status < 200 || response.status >= 400) {
        return { probe: { outcome: response.status === 410 ? 'gone' : 'unclear', url: input, finalUrl: current.toString(), status: response.status, reason: `HTTP ${response.status}` }, title: null };
      }
      const html = await readLimitedText(response, maxBytes);
      const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
      const title = match ? match[1].replace(/&amp;/gi, '&').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim() || null : null;
      return { probe: { outcome: 'reachable', url: input, finalUrl: current.toString(), status: response.status, reason: 'Website erreichbar' }, title };
    } catch (error) {
      const err = error as Error & { code?: string; cause?: { code?: string } };
      const code = err.code ?? err.cause?.code;
      if (code === 'ENOTFOUND' || code === 'ENODATA') return { probe: { outcome: 'gone', url: input, reason: `DNS ${code}` }, title: null };
      if (/Private|Lokale|HTTP\(S\)/.test(err.message)) return { probe: { outcome: 'blocked', url: input, reason: err.message }, title: null };
      return { probe: { outcome: 'unclear', url: input, reason: err.message }, title: null };
    }
  }
  return { probe: { outcome: 'unclear', url: input, reason: 'Zu viele Weiterleitungen' }, title: null };
}

export async function fetchPublicPageText(input: string, maxBytes = 50_000): Promise<{ probe: UrlProbe; text: string | null }> {
  let current: URL;
  try { current = new URL(input); } catch { return { probe: { outcome: 'unclear', url: input, reason: 'Ungueltige URL' }, text: null }; }
  for (let redirect = 0; redirect <= 5; redirect++) {
    try {
      await assertPublicTarget(current);
      const response = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': 'Vibe-Feedback-Precheck/1.0', Accept: 'text/html,text/plain,application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) return { probe: { outcome: 'unclear', url: input, status: response.status, reason: 'Weiterleitung ohne Ziel' }, text: null };
        current = new URL(location, current);
        continue;
      }
      if (response.status < 200 || response.status >= 400) {
        return { probe: { outcome: response.status === 410 ? 'gone' : 'unclear', url: input, finalUrl: current.toString(), status: response.status, reason: `HTTP ${response.status}` }, text: null };
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (!/text|json|html/i.test(contentType)) {
        return { probe: { outcome: 'reachable', url: input, finalUrl: current.toString(), status: response.status, reason: `Nicht-textuelle Quelle (${contentType || 'unbekannt'})` }, text: null };
      }
      const raw = await readLimitedText(response, maxBytes);
      const text = raw
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/\s+/g, ' ')
        .trim();
      return { probe: { outcome: 'reachable', url: input, finalUrl: current.toString(), status: response.status, reason: 'Quelle erreichbar' }, text: text || null };
    } catch (error) {
      const err = error as Error & { code?: string; cause?: { code?: string } };
      const code = err.code ?? err.cause?.code;
      if (code === 'ENOTFOUND' || code === 'ENODATA') return { probe: { outcome: 'gone', url: input, reason: `DNS ${code}` }, text: null };
      if (/Private|Lokale|HTTP\(S\)/.test(err.message)) return { probe: { outcome: 'blocked', url: input, reason: err.message }, text: null };
      return { probe: { outcome: 'unclear', url: input, reason: err.message }, text: null };
    }
  }
  return { probe: { outcome: 'unclear', url: input, reason: 'Zu viele Weiterleitungen' }, text: null };
}
