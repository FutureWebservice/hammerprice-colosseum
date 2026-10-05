import { describe, it, expect, afterEach } from 'vitest';
import { canOpen, hammerOutcome, isAuctioneer } from '../auctioneer';

describe('canOpen', () => {
  it('accepts a catalogued lot with no other lot open', () => {
    expect(canOpen({ lotState: 'catalogued', otherOpenLotExists: false })).toEqual({ ok: true });
  });

  it('rejects a lot that is not catalogued', () => {
    for (const lotState of ['open', 'sold', 'passed', 'withdrawn'] as const) {
      const r = canOpen({ lotState, otherOpenLotExists: false });
      expect(r.ok, lotState).toBe(false);
    }
  });

  it('rejects when another lot in the show is already open, even if this one is catalogued', () => {
    const r = canOpen({ lotState: 'catalogued', otherOpenLotExists: true });
    expect(r.ok).toBe(false);
  });
});

describe('hammerOutcome', () => {
  it('always honors an explicit withdrawn request regardless of bid/reserve', () => {
    expect(hammerOutcome({ highBid: BigInt(1_000_000), reserve: BigInt(1), requested: 'withdrawn' })).toBe('withdrawn');
    expect(hammerOutcome({ highBid: null, reserve: null, requested: 'withdrawn' })).toBe('withdrawn');
  });

  it('passes a lot with no bids', () => {
    expect(hammerOutcome({ highBid: null, reserve: BigInt(1_000_000), requested: 'sold' })).toBe('passed');
    expect(hammerOutcome({ highBid: null, reserve: null, requested: 'sold' })).toBe('passed');
  });

  it('sells any bid when the lot has no reserve', () => {
    expect(hammerOutcome({ highBid: BigInt(1), reserve: null, requested: 'sold' })).toBe('sold');
  });

  it('sells a high bid exactly equal to the reserve', () => {
    const reserve = BigInt(121_000_000);
    expect(hammerOutcome({ highBid: reserve, reserve, requested: 'sold' })).toBe('sold');
  });

  it('passes a high bid one base unit below the reserve', () => {
    const reserve = BigInt(121_000_000);
    expect(hammerOutcome({ highBid: reserve - BigInt(1), reserve, requested: 'sold' })).toBe('passed');
  });

  it('sells a high bid above the reserve', () => {
    const reserve = BigInt(121_000_000);
    expect(hammerOutcome({ highBid: reserve + BigInt(1), reserve, requested: 'sold' })).toBe('sold');
  });

  it('derives the outcome from bid vs reserve even when the caller requested "passed"', () => {
    // The client's intent is not trusted for sold/passed - only 'withdrawn' is a pure passthrough.
    const reserve = BigInt(121_000_000);
    expect(hammerOutcome({ highBid: reserve, reserve, requested: 'passed' })).toBe('sold');
  });
});

describe('isAuctioneer', () => {
  const ENV_KEY = 'OPERATOR_WALLETS';
  const originalEnv = process.env[ENV_KEY];

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalEnv;
  });

  it('authorises the show seller wallet', () => {
    expect(isAuctioneer('SellerWallet111', 'SellerWallet111')).toBe(true);
  });

  it('rejects a wallet that is neither the seller nor an operator', () => {
    delete process.env[ENV_KEY];
    expect(isAuctioneer('RandomWallet111', 'SellerWallet111')).toBe(false);
    expect(isAuctioneer('RandomWallet111', null)).toBe(false);
  });

  it('authorises an operator wallet on the house show only', () => {
    process.env[ENV_KEY] = 'OpsWallet111, OtherOps222';
    expect(isAuctioneer('OpsWallet111', 'SellerWallet111', { isHouse: true })).toBe(true);
    expect(isAuctioneer('OtherOps222', null, { isHouse: true })).toBe(true);
    expect(isAuctioneer('OpsWallet111', 'SellerWallet111', { isHouse: false })).toBe(false);
    expect(isAuctioneer('OpsWallet111', 'SellerWallet111')).toBe(false);
  });

  it('does not authorise an arbitrary wallet just because operators are set', () => {
    process.env[ENV_KEY] = 'OpsWallet111';
    expect(isAuctioneer('SomeoneElse111', 'SellerWallet111', { isHouse: true })).toBe(false);
  });

  it('an empty or blank OPERATOR_WALLETS grants nobody', () => {
    for (const v of ['', ' ', ' , ,']) {
      process.env[ENV_KEY] = v;
      expect(isAuctioneer('', null, { isHouse: true })).toBe(false);
      expect(isAuctioneer('x', 'y', { isHouse: true })).toBe(false);
    }
  });

  it('the old public override variable no longer does anything', () => {
    process.env.NEXT_PUBLIC_AUCTIONEER_WALLET = 'OpsWallet111';
    expect(isAuctioneer('OpsWallet111', 'SellerWallet111', { isHouse: true })).toBe(false);
    delete process.env.NEXT_PUBLIC_AUCTIONEER_WALLET;
  });
});
