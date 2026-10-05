import { describe, it, expect } from 'vitest';
import { nextIncrement, validateBid, bidStanding, isDuplicateNonceError } from '../bidding';

// BigInt(...) rather than n-suffixed literals: the tsconfig target predates BigInt literals
// (see lib/platform.ts).
const base = {
  amount: BigInt(0),
  highBid: null as bigint | null,
  opening: BigInt(1_000_000),   // $1.00
  increment: BigInt(100_000),   // $0.10
  lotState: 'open' as const,
  escrowBalance: BigInt(10_000_000), // $10.00
};

describe('nextIncrement', () => {
  it('is the opening price when nothing has bid yet', () => {
    expect(nextIncrement(null, BigInt(1_000_000), BigInt(100_000))).toBe(BigInt(1_000_000));
  });

  it('is one increment over the high bid otherwise', () => {
    expect(nextIncrement(BigInt(1_000_000), BigInt(1_000_000), BigInt(100_000))).toBe(BigInt(1_100_000));
  });
});

describe('validateBid', () => {
  it('rejects a lot that is not open', () => {
    for (const lotState of ['catalogued', 'sold', 'passed', 'withdrawn'] as const) {
      const r = validateBid({ ...base, amount: BigInt(1_000_000), lotState });
      expect(r.ok, lotState).toBe(false);
    }
  });

  it('accepts exactly the opening price as the first bid', () => {
    expect(validateBid({ ...base, amount: BigInt(1_000_000) }).ok).toBe(true);
  });

  it('rejects one base unit below the opening price', () => {
    expect(validateBid({ ...base, amount: BigInt(999_999) }).ok).toBe(false);
  });

  it('accepts exactly the next increment over a standing high bid', () => {
    const r = validateBid({ ...base, highBid: BigInt(1_000_000), amount: BigInt(1_100_000) });
    expect(r.ok).toBe(true);
  });

  it('rejects one base unit below the next increment', () => {
    const r = validateBid({ ...base, highBid: BigInt(1_000_000), amount: BigInt(1_099_999) });
    expect(r.ok).toBe(false);
  });

  it('rejects a bid over the escrow balance', () => {
    const r = validateBid({ ...base, amount: base.escrowBalance + BigInt(1) });
    expect(r.ok).toBe(false);
  });

  it('accepts a bid exactly at the escrow balance', () => {
    // escrowBalance sits above the next increment (opening) here, so this is the boundary.
    const r = validateBid({
      ...base, opening: base.escrowBalance, amount: base.escrowBalance,
    });
    expect(r.ok).toBe(true);
  });

  it('accepts a bid below the reserve but flags it', () => {
    const r = validateBid({ ...base, amount: BigInt(1_000_000), reserve: BigInt(5_000_000) });
    expect(r).toEqual({ ok: true, belowReserve: true });
  });

  it('does not flag a bid that meets the reserve', () => {
    const r = validateBid({ ...base, amount: BigInt(5_000_000), reserve: BigInt(5_000_000) });
    expect(r).toEqual({ ok: true, belowReserve: false });
  });

  it('never flags belowReserve when no reserve is set', () => {
    const r = validateBid({ ...base, amount: BigInt(1_000_000) });
    expect(r).toEqual({ ok: true, belowReserve: false });
  });
});

describe('bidStanding', () => {
  it('clears exactly at the reserve', () => {
    const r = bidStanding({ amount: BigInt(5_000_000), highBid: null, reserve: BigInt(5_000_000) });
    expect(r).toEqual({ clearsReserve: true, shortfall: null });
  });

  it('falls short by one base unit below the reserve', () => {
    const r = bidStanding({ amount: BigInt(4_999_999), highBid: null, reserve: BigInt(5_000_000) });
    expect(r).toEqual({ clearsReserve: false, shortfall: BigInt(1) });
  });

  it('always clears on a lot with no reserve set', () => {
    const r = bidStanding({ amount: BigInt(0), highBid: null, reserve: null });
    expect(r).toEqual({ clearsReserve: true, shortfall: null });
  });
});

describe('isDuplicateNonceError', () => {
  it('recognises a raw driver error with .code', () => {
    expect(isDuplicateNonceError({ code: '23505' })).toBe(true);
  });

  it('recognises drizzle-orm\'s wrapper, which nests the real error under .cause', () => {
    // What db.transaction() actually throws: a DrizzleQueryError with no .code of its own,
    // wrapping the real node-postgres-shaped error as .cause.
    const wrapped = { message: 'Failed query: insert into bids ...', cause: { code: '23505' } };
    expect(isDuplicateNonceError(wrapped)).toBe(true);
  });

  it('rejects an unrelated error code', () => {
    expect(isDuplicateNonceError({ code: '23503' })).toBe(false);
    expect(isDuplicateNonceError({ cause: { code: '23503' } })).toBe(false);
  });

  it('rejects non-error values without throwing', () => {
    expect(isDuplicateNonceError(null)).toBe(false);
    expect(isDuplicateNonceError(undefined)).toBe(false);
    expect(isDuplicateNonceError('boom')).toBe(false);
    expect(isDuplicateNonceError(new Error('plain'))).toBe(false);
  });
});
