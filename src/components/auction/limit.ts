import type { RoomLot } from './types';

/** A USDC amount string that is a real, positive number of base units (null, "", "0" and junk are not). */
export function positiveAmount(v: string | null | undefined): string | null {
  if (v == null || v === '') return null;
  try {
    return BigInt(v) > BigInt(0) ? v : null;
  } catch {
    return null;
  }
}

/**
 * The one number a lot shows before it sells, as the room draws it: the seller's minimum price (reserve); else, for a lot
 * with none, its insured value; else nothing ("none"). A reserve of 0 is no reserve. Callers print "No minimum" for
 * `none` and never an amount, so the room cannot show "n/a".
 */
export function lotLimit(lot: Pick<RoomLot, 'reserve' | 'insuredValue'>): { kind: 'reserve' | 'insured' | 'none'; value: string | null } {
  const reserve = positiveAmount(lot.reserve);
  if (reserve) return { kind: 'reserve', value: reserve };
  const insured = positiveAmount(lot.insuredValue);
  if (insured) return { kind: 'insured', value: insured };
  return { kind: 'none', value: null };
}
