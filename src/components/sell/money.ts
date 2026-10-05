/**
 * USDC amounts on the client. The wire format is a decimal string of base units (6 dp, see
 * contracts/common.ts Amount); people type "12.5" or "12,50". Everything here is bigint-exact,
 * no float ever touches an amount.
 */
const SCALE = 6;
const ONE = BigInt(10) ** BigInt(SCALE);
/** Same cap as the engine's MAX_BID (contracts/common.ts): 1,000,000 USDC. */
export const MAX_USDC_BASE = BigInt(1_000_000) * ONE;

export type AmountIssue = 'required' | 'invalid' | 'zero' | 'too_large';

/** "12.5", "12,50", "0.000001" -> base units as a decimal string. No thousands separators (ambiguous between locales). */
export function parseUsdc(input: string): { ok: true; base: string } | { ok: false; issue: AmountIssue } {
  const s = input.trim();
  if (s === '') return { ok: false, issue: 'required' };
  const m = /^(\d{1,9})(?:[.,](\d{1,6}))?$/.exec(s);
  if (!m) return { ok: false, issue: 'invalid' };
  const base = BigInt(m[1]) * ONE + BigInt((m[2] ?? '').padEnd(SCALE, '0') || '0');
  if (base === BigInt(0)) return { ok: false, issue: 'zero' };
  if (base > MAX_USDC_BASE) return { ok: false, issue: 'too_large' };
  return { ok: true, base: base.toString() };
}

/** Base units -> the text a person would type back in, with a dot (for input defaults). "12500000" -> "12.5". */
export function baseToInput(base: string): string {
  const v = BigInt(base);
  const whole = v / ONE;
  const frac = (v % ONE).toString().padStart(SCALE, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Base units -> "12.50 USDC" in the viewer's number format (at least 2 decimals, up to 6). */
export function formatUsdc(base: string | null | undefined, locale: string): string {
  if (base == null || !/^\d+$/.test(base)) return '';
  const v = BigInt(base);
  const whole = new Intl.NumberFormat(locale).format(v / ONE);
  let frac = (v % ONE).toString().padStart(SCALE, '0').replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  const sep = locale.startsWith('de') ? ',' : '.';
  return `${whole}${sep}${frac} USDC`;
}
