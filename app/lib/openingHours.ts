// Pragmatischer Parser für einen praxisrelevanten Teil der OSM-
// opening_hours-Syntax (https://wiki.openstreetmap.org/wiki/Key:opening_hours) —
// nicht die volle Spezifikation (die deckt u.a. Feiertage, Wochennummern,
// Sonderfälle wie "sunrise-sunset" ab, wofür es dedizierte Bibliotheken wie
// opening_hours.js gäbe). Deckt genau die Muster ab, die bei den echten
// Münchner Bar-Daten vorkommen (per Direktabruf gegen Overpass verifiziert,
// 2026-07): kommagetrennte Tagesregeln, Semikolon-getrennte Blöcke,
// Tagesbereiche (Mo-Fr), Zeitbereiche inkl. Über-Mitternacht (17:00-05:00),
// "off" für explizit geschlossen, "24/7". Alles, was der Parser nicht
// versteht, liefert null zurück — die UI zeigt dann den Rohtext statt eines
// falschen Status an, lieber ehrlich unbekannt als falsch "geöffnet".

const DAY_INDEX: Record<string, number> = { Su: 0, Mo: 1, Tu: 2, We: 3, Th: 4, Fr: 5, Sa: 6 };
const DAY_ORDER = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

interface TimeRange {
  startMinutes: number;
  // Kann > 1440 sein für Über-Mitternacht-Bereiche (17:00-05:00 -> 1020-1740).
  endMinutes: number;
}

interface DayRule {
  days: number[];
  ranges: TimeRange[];
  closed: boolean;
}

function parseTimeToMinutes(time: string): number | null {
  const match = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  // OSM erlaubt "24:00" als Tagesende — regulär ungültig für new Date(), hier
  // aber ein legitimer Wert (Mitternacht als Ende, nicht als nächster Tag).
  if (hours > 24 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function parseDayToken(token: string): number[] | null {
  const rangeMatch = token.match(/^([A-Za-z]{2})-([A-Za-z]{2})$/);
  if (rangeMatch) {
    const start = DAY_INDEX[rangeMatch[1]];
    const end = DAY_INDEX[rangeMatch[2]];
    if (start === undefined || end === undefined) return null;
    const days: number[] = [];
    let i = start;
    while (true) {
      days.push(i);
      if (i === end) break;
      i = (i + 1) % 7;
      // Notbremse gegen eine Endlosschleife bei unerwarteter Eingabe.
      if (days.length > 7) return null;
    }
    return days;
  }
  const single = DAY_INDEX[token];
  return single === undefined ? null : [single];
}

function parseTimeRangeToken(token: string): TimeRange | null {
  const match = token.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
  if (!match) return null;
  const start = parseTimeToMinutes(match[1]);
  const end = parseTimeToMinutes(match[2]);
  if (start === null || end === null) return null;
  // Ende <= Start heißt: Bereich geht über Mitternacht hinaus (z.B. 17:00-05:00).
  return { startMinutes: start, endMinutes: end <= start ? end + 24 * 60 : end };
}

export function parseOpeningHours(raw: string | null | undefined): DayRule[] | null {
  const source = raw?.trim();
  if (!source) return null;
  if (source === '24/7') {
    return [{ days: [0, 1, 2, 3, 4, 5, 6], ranges: [{ startMinutes: 0, endMinutes: 24 * 60 }], closed: false }];
  }

  const rules: DayRule[] = [];
  for (const block of source.split(';')) {
    const segment = block.trim();
    if (!segment) continue;

    // Ein Block ist "<Tage> <Zeitbereiche>", z.B. "Mo-Th 17:00-24:00, Fr 17:00-01:00"
    // enthält mehrere solcher Teilblöcke, kommagetrennt.
    for (const part of segment.split(',')) {
      const piece = part.trim();
      if (!piece) continue;
      const tokens = piece.split(/\s+/);
      if (tokens.length < 1) continue;

      const days = parseDayToken(tokens[0]);
      if (!days) return null; // unbekanntes Muster -> lieber ganz abbrechen als falsch parsen

      const rest = tokens.slice(1).join(' ');
      if (rest === 'off' || rest === '') {
        rules.push({ days, ranges: [], closed: rest === 'off' });
        continue;
      }

      const ranges: TimeRange[] = [];
      for (const timeToken of rest.split(/[,;]/).map((t) => t.trim()).filter(Boolean)) {
        const range = parseTimeRangeToken(timeToken);
        if (!range) return null;
        ranges.push(range);
      }
      if (ranges.length === 0) return null;
      rules.push({ days, ranges, closed: false });
    }
  }

  return rules.length > 0 ? rules : null;
}

// Prüft einen Zeitpunkt gegen alle Regeln — inklusive der Regeln vom
// VORTAG, deren Zeitbereich über Mitternacht in den aktuellen Tag hineinreicht.
function isWithinRules(rules: DayRule[], weekday: number, minutesOfDay: number): boolean {
  for (const rule of rules) {
    if (rule.closed) continue;
    if (rule.days.includes(weekday)) {
      for (const range of rule.ranges) {
        if (minutesOfDay >= range.startMinutes && minutesOfDay < range.endMinutes) return true;
      }
    }
    // Vortag-Regel, deren Über-Mitternacht-Bereich noch in den aktuellen Tag reicht.
    const previousWeekday = (weekday + 6) % 7;
    if (rule.days.includes(previousWeekday)) {
      for (const range of rule.ranges) {
        if (range.endMinutes > 24 * 60 && minutesOfDay < range.endMinutes - 24 * 60) return true;
      }
    }
  }
  return false;
}

export function isOpenNow(raw: string | null | undefined, at: Date = new Date()): boolean | null {
  const rules = parseOpeningHours(raw);
  if (!rules) return null;
  const weekday = at.getDay();
  const minutesOfDay = at.getHours() * 60 + at.getMinutes();
  return isWithinRules(rules, weekday, minutesOfDay);
}

// Kurzer, menschenlesbarer Hinweis für "heute" — z.B. "10:00-24:00" oder
// "geschlossen". Zeigt bei mehreren Zeitfenstern (Sperrzeit am Nachmittag)
// alle an.
export function todayLabel(raw: string | null | undefined, at: Date = new Date()): string | null {
  if (raw?.trim() === '24/7') return 'Durchgehend geöffnet';
  const rules = parseOpeningHours(raw);
  if (!rules) return null;
  const weekday = at.getDay();
  const todayRules = rules.filter((r) => r.days.includes(weekday));
  if (todayRules.length === 0) return null;
  if (todayRules.every((r) => r.closed)) return 'Geschlossen';

  const formatMinutes = (m: number) => {
    // Exakt 24:00 (Tagesende) bewusst nicht auf "00:00" zurückwickeln — das
    // läse sich wie Tagesbeginn statt Tagesende. Echte Über-Mitternacht-Werte
    // (z.B. 05:00 am Folgetag, > 1440) sollen dagegen normal umlaufen.
    if (m === 24 * 60) return '24:00';
    const wrapped = m % (24 * 60);
    const h = Math.floor(wrapped / 60);
    const min = wrapped % 60;
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  };

  const ranges = todayRules
    .filter((r) => !r.closed)
    .flatMap((r) => r.ranges)
    .map((r) => `${formatMinutes(r.startMinutes)}-${formatMinutes(r.endMinutes)}`);
  return ranges.length > 0 ? ranges.join(', ') : null;
}

export { DAY_ORDER };
