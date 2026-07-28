import { Platform, Linking } from 'react-native';

export type CalendarEventInput = {
  id: string;
  title: string;
  description?: string | null;
  start_date: string; // YYYY-MM-DD
  start_time?: string | null; // HH:MM oder HH:MM:SS
  location_name?: string | null;
  address?: string | null;
  source_url?: string | null;
};

const DEFAULT_DURATION_HOURS = 2;

function pad(n: number) {
  return String(n).padStart(2, '0');
}

function formatLocal(date: Date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function formatDateOnly(date: Date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

function formatUtcStamp(date: Date) {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

// Escaped nach RFC 5545 (iCalendar) — Backslash, Semikolon, Komma und
// Zeilenumbrüche müssen in Textfeldern maskiert werden.
function escapeIcsText(text: string) {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

export function buildIcsContent(event: CalendarEventInput): string {
  const [year, month, day] = event.start_date.split('-').map(Number);
  const location = [event.location_name, event.address].filter(Boolean).join(', ');

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Vibe//Events//DE',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${event.id}@vibe-app`,
    `DTSTAMP:${formatUtcStamp(new Date())}`,
  ];

  if (event.start_time) {
    const [hour, minute] = event.start_time.split(':').map(Number);
    const start = new Date(year, month - 1, day, hour, minute);
    const end = new Date(start.getTime() + DEFAULT_DURATION_HOURS * 60 * 60 * 1000);
    // Floating local time (kein Z/TZID) — die App kennt für Events keine
    // Zeitzone, alle Events sind aber ohnehin in München/Europe-Berlin.
    lines.push(`DTSTART:${formatLocal(start)}`, `DTEND:${formatLocal(end)}`);
  } else {
    const start = new Date(year, month - 1, day);
    const end = new Date(year, month - 1, day + 1);
    lines.push(`DTSTART;VALUE=DATE:${formatDateOnly(start)}`, `DTEND;VALUE=DATE:${formatDateOnly(end)}`);
  }

  lines.push(`SUMMARY:${escapeIcsText(event.title)}`);
  if (location) lines.push(`LOCATION:${escapeIcsText(location)}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
  if (event.source_url) lines.push(`URL:${event.source_url}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');

  return lines.join('\r\n');
}

// Öffnet den .ics-Inhalt so, dass Browser/OS ihn als Kalendereintrag anbieten.
// Web: Blob-URL direkt aufrufen (Safari/Chrome erkennen text/calendar und
// bieten "Zum Kalender hinzufügen" an). Nativ: data:-URI über Linking, für
// den Fall, dass die App doch mal wieder nativ gebaut wird.
export function addEventToCalendar(event: CalendarEventInput) {
  const ics = buildIcsContent(event);

  if (Platform.OS === 'web') {
    const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    window.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return;
  }

  const dataUrl = `data:text/calendar;charset=utf-8,${encodeURIComponent(ics)}`;
  Linking.openURL(dataUrl).catch(() => {});
}
