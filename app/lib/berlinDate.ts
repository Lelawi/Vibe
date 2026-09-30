// Heutiges Datum (bzw. heute + n Tage) in München als YYYY-MM-DD.
// `new Date().toISOString().slice(0, 10)` liefert das UTC-Datum — zwischen
// 0 und 2 Uhr nachts galt in den Abfragen damit noch der Vortag, und
// "heute" schloss bereits vergangene Events ein (Fund 2026-09-30).
export function berlinToday(offsetDays = 0): string {
  const now = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}
