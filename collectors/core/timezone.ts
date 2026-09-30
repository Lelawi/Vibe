// events.start_date/start_time werden als naives Europe/Berlin-Wandzeit
// gespeichert (kein UTC, keine Zeitzoneninfo im String — siehe App-Anzeige
// "20:00 Uhr", die den Wert unverändert übernimmt). `new Date(`${date}T${time}`)`
// interpretiert einen Timezone-losen ISO-String laut Spec als *lokale* Zeit
// der ausführenden Umgebung. Im Browser der Nutzer:innen (Europe/Berlin) ist
// das zufällig richtig, auf dem GitHub-Actions-Runner (TZ=UTC) verschiebt es
// jede Berechnung um die aktuelle Berlin-UTC-Differenz — 1h im Winter (CET),
// 2h im Sommer (CEST) — und damit "3h vorher"-Erinnerungen entsprechend aus
// dem Fenster. Diese Funktion rechnet die Wandzeit korrekt in einen echten
// UTC-Zeitpunkt um (per Doppel-Konvertierung über Intl, DST-sicher).
export function berlinWallClockToDate(dateStr: string, timeStr: string): Date {
  const asIfUtc = new Date(`${dateStr}T${timeStr}Z`);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Berlin',
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(asIfUtc).map((part) => [part.type, part.value])
  );
  const asIfUtcInterpretedAsBerlin = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second)
  );
  const offsetMs = asIfUtcInterpretedAsBerlin - asIfUtc.getTime();
  return new Date(asIfUtc.getTime() - offsetMs);
}

// Heutiges Datum in Berlin als YYYY-MM-DD — unabhängig von der Zeitzone der
// ausführenden Umgebung (GH-Actions-Runner laufen in UTC, lokale Läufe in
// Europe/Berlin; `new Date().toISOString().slice(0, 10)` liefert zwischen
// 0 und 2 Uhr Berliner Zeit noch den Vortag).
export function berlinToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

// Datum OHNE Jahresangabe ("18.07.", "Jul 28") -> YYYY-MM-DD. Nimmt das
// laufende Jahr, außer der Tag liegt mehr als maxPastDays zurück — erst dann
// ist das nächste Jahr gemeint (Dezember-Listing mit "05.01.").
//
// Vorher verglichen die Parser Mitternacht-UTC des Kandidaten mit "jetzt" und
// schoben damit schon HEUTIGE sowie kürzlich vergangene, noch gelistete
// Termine ins Folgejahr (Fund 2026-09-30: >80 Phantom-Events für 2027, u.a.
// glockenbachwerkstatt 45, import_export 36). Kürzlich vergangene Termine
// bleiben jetzt in der Vergangenheit und werden von den Quellen bzw. der App
// ausgefiltert statt als Geister-Termin im nächsten Jahr aufzutauchen.
export function resolveYearlessDate(month: number, day: number, now = new Date(), maxPastDays = 60): string | null {
  const today = berlinToday(now);
  const todayMs = Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)));
  let year = Number(today.slice(0, 4));
  const build = (y: number) => {
    const d = new Date(Date.UTC(y, month - 1, day));
    // 31.02. o.ä. nicht still in den März rollen lassen
    if (isNaN(d.getTime()) || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
    return d;
  };
  let candidate = build(year);
  if (!candidate) return null;
  if ((todayMs - candidate.getTime()) / 86_400_000 > maxPastDays) {
    year += 1;
    candidate = build(year);
    if (!candidate) return null;
  }
  return candidate.toISOString().slice(0, 10);
}

// ISO-Zeitstempel aus einer Quelle -> Berliner Wandzeit { date, time }, so
// wie events.start_date/start_time sie erwarten (naiv, Europe/Berlin).
// - Mit Offset/Z ("2026-10-01T18:00:00Z", "...+02:00"): echter Zeitpunkt,
//   wird nach Berlin umgerechnet. Vorher nahmen backstage/eintrittfrei/
//   lieber-scholli per toISOString() einfach die UTC-Uhrzeit — alle Termine
//   standen 1–2h zu früh (Fund 2026-09-30, z.B. 18:00 statt 20:00).
// - Ohne Offset ("2026-10-01T20:00:00"): ist bereits Wandzeit, wird wörtlich
//   übernommen (new Date() würde sie sonst je nach Rechner-Zeitzone
//   verschieben).
// time ist null, wenn der String keine Uhrzeit enthält.
export function isoToBerlinWallClock(iso: string): { date: string; time: string | null } | null {
  const naive = iso.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?)?$/);
  if (naive) return { date: naive[1], time: naive[2] ?? null };
  const instant = new Date(iso);
  if (isNaN(instant.getTime())) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Berlin', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(instant).map((part) => [part.type, part.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
