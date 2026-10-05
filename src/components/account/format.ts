/** Small pure formatters and the identicon for the profile page. No React, no fetch. */

const LAMPORTS = 1_000_000_000n;

/** "1.2345 SOL": whole SOL plus up to 4 decimals (the 9th decimal digits of a lamport count are noise to a person). Null stays null. */
export function formatSol(lamports: string | null | undefined, locale: string): string | null {
  if (lamports == null || !/^\d{1,20}$/.test(lamports)) return null;
  const n = BigInt(lamports);
  const whole = n / LAMPORTS;
  const frac = Number((n % LAMPORTS) / 100_000n) / 10_000; // 4 decimals, truncated
  return `${new Intl.NumberFormat(locale, { minimumFractionDigits: 0, maximumFractionDigits: 4 }).format(Number(whole) + frac)} SOL`;
}

/** The day a member joined, in the site's time zone ("5 October 2026" / "5. Oktober 2026"). An unreadable date is an empty string. */
export function formatDay(iso: string, locale: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'Europe/Berlin' }).format(d);
}

/** FNV-1a, 32 bit: a stable number per string, enough to colour and shape an identicon. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/**
 * A generated picture for a profile without one: a 5 by 5 mirrored pattern and a hue, both from the seed (the profile id), so it is the same on
 * every device and never needs a request. Returns the filled cells of the left three columns (the right two mirror them).
 */
export function identicon(seed: string): { hue: number; cells: boolean[][] } {
  const a = hash32(seed);
  const b = hash32(`${seed}:2`);
  const bits = ((BigInt(a) << 32n) | BigInt(b));
  const cells = Array.from({ length: 5 }, (_, y) => Array.from({ length: 5 }, (_, x) => {
    const col = x < 3 ? x : 4 - x;
    return ((bits >> BigInt(y * 3 + col)) & 1n) === 1n;
  }));
  // A pattern with fewer than 5 filled cells reads as empty: fill the centre column so every profile has a visible shape.
  if (cells.flat().filter(Boolean).length < 5) for (let y = 0; y < 5; y++) cells[y][2] = true;
  return { hue: a % 360, cells };
}
