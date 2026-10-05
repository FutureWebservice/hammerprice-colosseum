/**
 * Dates on the client. The seller types a start time in the local zone (<input type="datetime-local">
 * has no zone); the API stores and returns UTC ISO strings; every viewer sees it in their own zone.
 */

const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const pad = (n: number) => String(n).padStart(2, '0');

/** "2026-10-06T20:00" typed in the local zone -> "2026-10-06T18:00:00.000Z". null when empty or not a real date. */
export function localInputToIso(value: string): string | null {
  const m = LOCAL_INPUT.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const date = new Date(y, mo - 1, d, h, mi, 0, 0);
  // new Date rolls 2026-02-31 over to March; reject anything that did not round-trip.
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** A UTC instant -> the value a datetime-local input shows for the local zone. */
export function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The suggested start: one hour from now, rounded up to the next quarter hour, as a local input value. */
export function defaultStartLocal(now: Date): string {
  const t = new Date(now.getTime() + 60 * 60_000);
  t.setSeconds(0, 0);
  t.setMinutes(Math.ceil(t.getMinutes() / 15) * 15); // 60 rolls the hour over by itself
  return isoToLocalInput(t.toISOString());
}

/** A start time must lie at least this far in the future when the show is published. */
export const MIN_LEAD_MS = 5 * 60_000;

export type StartIssue = 'invalid' | 'too_soon';
/** Empty is fine (the seller starts the show by hand). */
export function checkStart(value: string, now: Date): StartIssue | null {
  if (value.trim() === '') return null;
  const iso = localInputToIso(value);
  if (!iso) return 'invalid';
  return new Date(iso).getTime() - now.getTime() < MIN_LEAD_MS ? 'too_soon' : null;
}

/** "Tue, Oct 6, 8:00 PM CEST": the instant in the viewer's own zone, with the zone named. */
export function formatWhen(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale === 'de' ? 'de-DE' : 'en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date(iso));
}

/** "12 minutes", "3 hours", "30 Sekunden": a wait in the viewer's language. */
export function formatWait(seconds: number, locale: string): string {
  const s = Math.max(1, Math.round(seconds));
  const [unit, n] = s >= 3600 ? (['hour', Math.ceil(s / 3600)] as const) : s >= 60 ? (['minute', Math.ceil(s / 60)] as const) : (['second', s] as const);
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'long' }).format(n);
}

/** Time until `iso`: "2d 03:04:05" / "03:04:05" / "00:45". null once the moment has passed. */
export function countdown(iso: string, nowMs: number): string | null {
  const ms = new Date(iso).getTime() - nowMs;
  if (!(ms > 0)) return null;
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}d ${pad(h)}:${pad(m)}:${pad(s)}`;
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

const icsStamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** A one-event calendar file (RFC 5545) for a scheduled room. The end is a one-hour placeholder: the real length depends on the lots. */
export function buildIcs(ev: { id: string; title: string; startIso: string; url: string; now?: Date }): string {
  const start = new Date(ev.startIso);
  const end = new Date(start.getTime() + 60 * 60_000);
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Hammerprice//Schedule//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${ev.id}@hammerprice`,
    `DTSTAMP:${icsStamp(ev.now ?? new Date())}`,
    `DTSTART:${icsStamp(start)}`,
    `DTEND:${icsStamp(end)}`,
    `SUMMARY:${icsText(ev.title)}`,
    `URL:${ev.url}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

export const icsHref = (ics: string) => `data:text/calendar;charset=utf-8,${encodeURIComponent(ics)}`;
