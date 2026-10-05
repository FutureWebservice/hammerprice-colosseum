/**
 * The one place fees are decided. Bigint only (USDC base units, 6 dp), never floats.
 *
 * The platform fee is a percentage of the hammer price paid by the seller (no buyer premium). An optional
 * creator royalty (the asset's Core Royalties plugin, known to the chain layer) is carved out of the seller's
 * proceeds too, so seller + platform + royalty always equals the gross exactly.
 */

/** 2.5%. The UI shows the same constant. */
export const FEE_BPS_DEFAULT = 250;
/** Anything above 10% is a typo, not a price. */
export const FEE_BPS_MAX = 1000;
const BPS = 10_000n;

/**
 * PLATFORM_FEE_BPS. Unset, empty, blank, non-numeric, negative, fractional or above FEE_BPS_MAX falls back to the
 * default. An explicit "0" is a real choice and is honoured; `Number("")` is 0 and must never get here by accident.
 */
export function parseFeeBps(raw: string | undefined): number {
  const s = raw?.trim();
  if (!s || !/^\d{1,5}$/.test(s)) return FEE_BPS_DEFAULT;
  const n = Number(s);
  return n <= FEE_BPS_MAX ? n : FEE_BPS_DEFAULT;
}

/** The configured fee. Falls back to the default on the client, where the server variable is absent. */
export function platformFeeBps(env: Record<string, string | undefined> = process.env): number {
  return parseFeeBps(env.PLATFORM_FEE_BPS);
}

export interface GrossSplit { seller: bigint; platform: bigint; royalty: bigint }

/** platform = floor(gross x feeBps / 10000), royalty = floor(gross x royaltyBps / 10000), seller = the rest. */
export function splitGross(gross: bigint, feeBps: number, royaltyBps = 0): GrossSplit {
  if (gross < 0n) throw new RangeError('gross must not be negative');
  for (const b of [feeBps, royaltyBps]) if (!Number.isInteger(b) || b < 0 || b > 10_000) throw new RangeError('bps must be an integer from 0 to 10000');
  if (feeBps + royaltyBps > 10_000) throw new RangeError('fee and royalty together exceed 100%');
  const platform = (gross * BigInt(feeBps)) / BPS;
  const royalty = (gross * BigInt(royaltyBps)) / BPS;
  return { seller: gross - platform - royalty, platform, royalty };
}
