/**
 * Time text for auctions that run for hours or days. Pure: no clock, no DOM; the caller passes the milliseconds and the locale.
 *
 *   formatRemaining   "2 T 03:12:44" (a day or more), "3 h 12 min" (an hour or more), "7:03" (under an hour, same as the live room's countdown)
 *   formatEndsAt      "Fri, 9 Oct, 21:15" in the viewer's own zone (Intl)
 *   formatDurationS   "1 h", "24 h", "3 T": the preset labels of the duration picker
 *   formatExtension   "2 min 37 s", "1 h 5 min": an odd length exactly (the chip that says how far a late bid moved the end)
 *   formatDurationLong the same length in words for a sentence ("5 minutes", "3 Tage")
 *
 * Under an hour the output is character for character what `formatCountdown` (lib/client/clock.ts) printed before, so a live lot looks the same.
 */

const pad = (n: number): string => String(n).padStart(2, '0');
const dayUnit = (locale: string): string => (locale.toLowerCase().startsWith('de') ? 'T' : 'd');

/** Rounds seconds up (0.4 s left reads 0:01), never negative; null (no deadline) reads "--:--". */
export function formatRemaining(ms: number | null, locale = 'en'): string {
  if (ms == null || !Number.isFinite(ms)) return '--:--';
  const s = Math.max(0, Math.ceil(ms / 1000));
  const d = Math.floor(s / 86_400);
  if (d >= 1) return `${d} ${dayUnit(locale)} ${pad(Math.floor((s % 86_400) / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  const h = Math.floor(s / 3600);
  if (h >= 1) return `${h} h ${Math.floor((s % 3600) / 60)} min`;
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/** The moment in the viewer's zone, zone named ("Fri, 9 Oct, 21:15 CEST"). `timeZone` is for tests. */
export function formatEndsAt(epochMs: number, locale = 'en', timeZone?: string): string {
  return new Intl.DateTimeFormat(locale.toLowerCase().startsWith('de') ? 'de-DE' : 'en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short', ...(timeZone ? { timeZone } : {}),
  }).format(new Date(epochMs));
}

/** A length of time as a short label: whole days from two days on ("3 T"), else whole hours ("24 h"), else minutes, else seconds. */
export function formatDurationS(seconds: number, locale = 'en'): string {
  const s = Math.max(0, Math.round(seconds));
  if (s >= 2 * 86_400 && s % 86_400 === 0) return `${s / 86_400} ${dayUnit(locale)}`;
  if (s >= 3600 && s % 3600 === 0) return `${s / 3600} h`;
  if (s >= 60 && s % 60 === 0) return `${s / 60} min`;
  return `${s} s`;
}

/** The same length in words for a sentence ("5 minutes", "24 hours", "3 days" / "5 Minuten", "24 Stunden", "3 Tage"), by the same unit rule as formatDurationS. */
export function formatDurationLong(seconds: number, locale = 'en'): string {
  const s = Math.max(0, Math.round(seconds));
  const [unit, n] = s >= 2 * 86_400 && s % 86_400 === 0 ? (['day', s / 86_400] as const) : s >= 3600 && s % 3600 === 0 ? (['hour', s / 3600] as const) : s >= 60 && s % 60 === 0 ? (['minute', s / 60] as const) : (['second', s] as const);
  return new Intl.NumberFormat(locale.toLowerCase().startsWith('de') ? 'de-DE' : 'en-GB', { style: 'unit', unit, unitDisplay: 'long' }).format(n);
}

/** An odd length of time exactly, in the units a person reads: "45 s", "2 min 37 s", "5 min", "1 h 5 min". */
export function formatExtension(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return s % 60 === 0 ? `${s / 60} min` : `${Math.floor(s / 60)} min ${s % 60} s`;
  const m = Math.floor((s % 3600) / 60);
  return m === 0 ? `${Math.floor(s / 3600)} h` : `${Math.floor(s / 3600)} h ${m} min`;
}
