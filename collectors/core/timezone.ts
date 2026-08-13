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
