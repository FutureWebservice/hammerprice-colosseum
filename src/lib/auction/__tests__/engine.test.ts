import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { MAX_BID } from '@/contracts/common';
import { ERROR_CODES } from '@/contracts/errors';
import { hammerOutcome } from '@/lib/auctioneer';
import { decideBid, decideTick, extendedClosesAt, minNextBid, nextClosesAt, outcomeAtClose, type DecideBidInput, type TickInput } from '../engine';
import { RULE_DEFAULTS, resolveRules } from '../rules';

const T = 1_700_000_000_000;
const USDC = 1_000_000n;
const base = (over: Partial<{ [K in keyof DecideBidInput]: Partial<DecideBidInput[K]> | DecideBidInput[K] }> = {}): DecideBidInput => ({
  lot: { state: 'open', highBid: null, highBidderId: null, openingPrice: 50n * USDC, increment: 5n * USDC, reserve: 100n * USDC, closesAt: T + 30_000, openedAt: T - 15_000, sellerProfileId: 'seller', sellerWallet: 'SELLERW', ...(over.lot as object) },
  show: { status: 'live', rules: RULE_DEFAULTS, isHouse: false, sellerProfileId: 'seller', sellerWallet: 'SELLERW', ...(over.show as object) },
  bidder: { profileId: 'bob', wallet: 'BOBW', isBanned: false, isBot: false, ...(over.bidder as object) },
  paddle: over.paddle === undefined ? { number: 7, validUntil: T + 3_600_000, revoked: false, maxBid: null } : (over.paddle as DecideBidInput['paddle']),
  via: (over.via as DecideBidInput['via']) ?? 'wallet',
  amount: (over.amount as bigint) ?? 50n * USDC,
  nowMs: (over.nowMs as number) ?? T,
  available: (over.available as bigint) ?? 1000n * USDC,
});
const code = (i: DecideBidInput) => { const r = decideBid(i); return r.ok ? 'ok' : r.code; };

describe('decideBid: every code', () => {
  it('accepts a first bid at the opening price and reports reserve status', () => {
    const r = decideBid(base());
    expect(r).toMatchObject({ ok: true, belowReserve: true, extended: false, closesAt: T + 30_000 });
    expect(decideBid(base({ amount: 100n * USDC }))).toMatchObject({ ok: true, belowReserve: false });
    expect(decideBid(base({ lot: { reserve: null } }))).toMatchObject({ ok: true, belowReserve: false });
  });
  it('show_not_live for a scheduled show, and for an ended show with no open lot', () => {
    expect(code(base({ show: { status: 'scheduled' } }))).toBe('show_not_live');
    expect(code(base({ show: { status: 'ended' }, lot: { state: 'sold' } }))).toBe('show_not_live');
  });
  it('an ended show keeps taking bids on the lot that is still running', () => {
    expect(code(base({ show: { status: 'ended' } }))).toBe('ok');
  });
  it('lot_not_open for a catalogued lot and for a lot that is not timed', () => {
    expect(code(base({ lot: { state: 'catalogued', closesAt: null } }))).toBe('lot_not_open');
    expect(code(base({ lot: { closesAt: null } }))).toBe('lot_not_open');
  });
  it('lot_closed for sold, passed, withdrawn', () => {
    for (const state of ['sold', 'passed', 'withdrawn'] as const) expect(code(base({ lot: { state } }))).toBe('lot_closed');
  });
  it('deadline boundary: 1 ms before accepted, at or after refused', () => {
    expect(code(base({ nowMs: T + 30_000 - 1 }))).toBe('ok');
    expect(code(base({ nowMs: T + 30_000 }))).toBe('lot_closed');
    expect(code(base({ nowMs: T + 30_001 }))).toBe('lot_closed');
  });
  it('banned', () => expect(code(base({ bidder: { isBanned: true } }))).toBe('banned'));
  it('house bidders only on the house show, and only bots bid as the house', () => {
    expect(code(base({ bidder: { isBot: true } }))).toBe('forbidden');
    expect(code(base({ via: 'house', bidder: { isBot: true } }))).toBe('forbidden');
    expect(code(base({ via: 'house', show: { isHouse: true } }))).toBe('forbidden'); // not a bot
    expect(code(base({ via: 'house', bidder: { isBot: true }, show: { isHouse: true } }))).toBe('ok');
  });
  it('demo (house) room: two people outbid each other exactly like in any room, and a person can outbid a house bidder', () => {
    const house = { isHouse: true, sellerProfileId: 'house', sellerWallet: 'HOUSEW' };
    const lot = { highBid: 50n * USDC, highBidderId: 'amy', sellerProfileId: 'house', sellerWallet: 'HOUSEW' };
    // amy leads, bob (a person, not a bot, via the wallet) outbids at the next increment
    expect(code(base({ show: house, lot, amount: 55n * USDC }))).toBe('ok');
    expect(code(base({ show: house, lot, amount: 54n * USDC }))).toBe('bid_too_low');
    // and amy outbids bob back; she cannot outbid herself
    expect(code(base({ show: house, lot: { ...lot, highBid: 55n * USDC, highBidderId: 'bob' }, bidder: { profileId: 'amy', wallet: 'AMYW' }, amount: 60n * USDC }))).toBe('ok');
    expect(code(base({ show: house, lot, bidder: { profileId: 'amy', wallet: 'AMYW' }, amount: 55n * USDC }))).toBe('already_high_bidder');
    // a person outbids a house bidder's lead
    expect(code(base({ show: house, lot: { ...lot, highBidderId: 'house-bot-1' }, amount: 55n * USDC }))).toBe('ok');
    // the same rule on the house show and on a seller's room: the house flag changes nothing for people
    for (const isHouse of [true, false]) expect(decideBid(base({ show: { isHouse }, lot: { highBid: 50n * USDC, highBidderId: 'amy' }, amount: 55n * USDC }))).toMatchObject({ ok: true });
  });
  it('no_paddle: missing, revoked, expired, and session bids above the authorised max', () => {
    expect(code(base({ paddle: null }))).toBe('no_paddle');
    expect(code(base({ paddle: { number: 1, validUntil: T + 1000, revoked: true, maxBid: null } }))).toBe('no_paddle');
    expect(code(base({ paddle: { number: 1, validUntil: T, revoked: false, maxBid: null } }))).toBe('no_paddle');
    expect(code(base({ via: 'session', amount: 60n * USDC, paddle: { number: 1, validUntil: T + 1000, revoked: false, maxBid: 55n * USDC } }))).toBe('no_paddle');
    expect(code(base({ via: 'session', amount: 55n * USDC, paddle: { number: 1, validUntil: T + 1000, revoked: false, maxBid: 55n * USDC } }))).toBe('ok');
    // a wallet-signed bid is not bound by the session key's max
    expect(code(base({ via: 'wallet', amount: 60n * USDC, paddle: { number: 1, validUntil: T + 1000, revoked: false, maxBid: 55n * USDC } }))).toBe('ok');
  });
  it('self_bid: lot seller, show seller, or either seller wallet', () => {
    expect(code(base({ bidder: { profileId: 'seller' } }))).toBe('self_bid');
    expect(code(base({ bidder: { profileId: 'showseller' }, show: { sellerProfileId: 'showseller' } }))).toBe('self_bid');
    expect(code(base({ bidder: { wallet: 'SELLERW' } }))).toBe('self_bid');
    expect(code(base({ bidder: { wallet: 'SHOWW' }, show: { sellerWallet: 'SHOWW' } }))).toBe('self_bid');
    expect(code(base({ lot: { sellerWallet: null }, show: { sellerWallet: null } }))).toBe('ok');
  });
  it('already_high_bidder', () => expect(code(base({ lot: { highBid: 50n * USDC, highBidderId: 'bob' } }))).toBe('already_high_bidder'));
  it('bid_too_low with minNext: amount = min accepted, min - 1 refused', () => {
    expect(code(base({ amount: 50n * USDC }))).toBe('ok');
    const r = decideBid(base({ amount: 50n * USDC - 1n }));
    expect(r).toMatchObject({ ok: false, code: 'bid_too_low', minNext: 50n * USDC });
    const high = { lot: { highBid: 80n * USDC, highBidderId: 'alice' } };
    expect(code(base({ ...high, amount: 85n * USDC }))).toBe('ok');
    expect(decideBid(base({ ...high, amount: 85n * USDC - 1n }))).toMatchObject({ ok: false, code: 'bid_too_low', minNext: 85n * USDC });
    expect(code(base({ amount: 0n }))).toBe('bid_too_low');
    expect(code(base({ amount: -5n }))).toBe('bid_too_low');
  });
  it('amount_too_large: above MAX_BID, and any bigint above int8', () => {
    expect(code(base({ amount: MAX_BID, available: MAX_BID }))).toBe('ok');
    expect(code(base({ amount: MAX_BID + 1n, available: MAX_BID * 10n }))).toBe('amount_too_large');
    expect(code(base({ amount: 2n ** 63n, available: 2n ** 70n }))).toBe('amount_too_large');
    expect(code(base({ amount: 2n ** 200n, available: 2n ** 201n }))).toBe('amount_too_large');
  });
  it('insufficient_funds: amount = available accepted, available + 1 refused', () => {
    expect(code(base({ amount: 50n * USDC, available: 50n * USDC }))).toBe('ok');
    expect(code(base({ amount: 50n * USDC, available: 50n * USDC - 1n }))).toBe('insufficient_funds');
    expect(code(base({ available: 0n }))).toBe('insufficient_funds');
  });
  it('first failure wins', () => {
    expect(code(base({ show: { status: 'scheduled' }, bidder: { isBanned: true }, amount: 1n }))).toBe('show_not_live');
    expect(code(base({ bidder: { isBanned: true }, paddle: null }))).toBe('banned');
    expect(code(base({ paddle: null, bidder: { profileId: 'seller' } }))).toBe('no_paddle');
    expect(code(base({ bidder: { profileId: 'seller' }, amount: 1n }))).toBe('self_bid');
    expect(code(base({ amount: 1n, available: 0n }))).toBe('bid_too_low');
  });
  it('every reason code it can return is a known ErrorCode', () => {
    const inputs = [base({ show: { status: 'scheduled' } }), base({ lot: { state: 'sold' } }), base({ bidder: { isBanned: true } }), base({ paddle: null }), base({ amount: 1n }), base({ available: 0n }), base({ amount: MAX_BID + 1n })];
    for (const i of inputs) { const r = decideBid(i); if (!r.ok) expect(ERROR_CODES).toContain(r.code); }
  });
  it('reasons use no em dashes', () => {
    for (const i of [base({ paddle: null }), base({ amount: 1n }), base({ available: 0n })]) { const r = decideBid(i); if (!r.ok) expect(r.reason).not.toContain('\u2014'); }
  });
});

describe('nextClosesAt (anti-sniping)', () => {
  const rules = resolveRules({ lotDurationS: 45, snipeWindowS: 15, snipeExtendS: 15, maxExtensionS: 120 });
  const opened = T; const closes = T + 45_000;
  it('does not extend outside the window', () => {
    expect(nextClosesAt({ closesAt: closes, openedAt: opened, now: closes - 15_001, rules })).toEqual({ closesAt: closes, extended: false });
  });
  it('extends to now + snipeExtendS inside the window (boundary at exactly 15 s)', () => {
    expect(nextClosesAt({ closesAt: closes, openedAt: opened, now: closes - 15_000, rules })).toEqual({ closesAt: closes, extended: false }); // now+15s == closes: no gain
    expect(nextClosesAt({ closesAt: closes, openedAt: opened, now: closes - 5_000, rules })).toEqual({ closesAt: closes + 10_000, extended: true });
    expect(nextClosesAt({ closesAt: closes, openedAt: opened, now: closes - 1, rules })).toEqual({ closesAt: closes + 14_999, extended: true });
  });
  it('never goes past opened + duration + maxExtension', () => {
    const cap = opened + 165_000;
    const r = nextClosesAt({ closesAt: cap - 3_000, openedAt: opened, now: cap - 4_000, rules });
    expect(r.closesAt).toBe(cap);
    expect(nextClosesAt({ closesAt: cap, openedAt: opened, now: cap - 1_000, rules })).toEqual({ closesAt: cap, extended: false });
  });
  it('a zero window or zero extension never extends', () => {
    expect(nextClosesAt({ closesAt: closes, openedAt: opened, now: closes - 1, rules: resolveRules({ snipeWindowS: 0 }) }).extended).toBe(false);
    expect(nextClosesAt({ closesAt: closes, openedAt: opened, now: closes - 1, rules: resolveRules({ snipeExtendS: 0 }) }).extended).toBe(false);
  });
  it('the cap survives a pre-extended deadline (never moves backwards)', () => {
    const r = nextClosesAt({ closesAt: opened + 200_000, openedAt: opened, now: opened + 199_000, rules });
    expect(r.closesAt).toBe(opened + 200_000);
  });
  it('an unknown openedAt falls back to closes - duration', () => {
    expect(nextClosesAt({ closesAt: closes, openedAt: null, now: closes - 1, rules }).extended).toBe(true);
  });
  it('closesAt never decreases and never exceeds the cap over any bid sequence (property)', () => {
    fc.assert(fc.property(fc.integer({ min: 10, max: 300 }), fc.integer({ min: 0, max: 60 }), fc.integer({ min: 0, max: 60 }), fc.integer({ min: 0, max: 300 }), fc.array(fc.integer({ min: 1, max: 40_000 }), { minLength: 1, maxLength: 60 }), (dur, win, ext, maxExt, steps) => {
      const r = resolveRules({ lotDurationS: dur, snipeWindowS: win, snipeExtendS: ext, maxExtensionS: maxExt });
      const cap = T + (r.lotDurationS + r.maxExtensionS) * 1000;
      let closesAt = T + r.lotDurationS * 1000; let now = T;
      for (const s of steps) {
        now += s; if (now >= closesAt) break;
        const n = nextClosesAt({ closesAt, openedAt: T, now, rules: r });
        expect(n.closesAt).toBeGreaterThanOrEqual(closesAt);
        expect(n.closesAt).toBeLessThanOrEqual(cap);
        expect(n.extended).toBe(n.closesAt > closesAt);
        closesAt = n.closesAt;
      }
    }));
  });
});

describe('extendedClosesAt (seller extend)', () => {
  const rules = resolveRules({ lotDurationS: 45, maxExtensionS: 30 });
  it('adds the seconds but respects the same cap, never backwards', () => {
    expect(extendedClosesAt({ closesAt: T + 45_000, openedAt: T, seconds: 10, rules })).toBe(T + 55_000);
    expect(extendedClosesAt({ closesAt: T + 45_000, openedAt: T, seconds: 600, rules })).toBe(T + 75_000);
    expect(extendedClosesAt({ closesAt: T + 75_000, openedAt: T, seconds: 10, rules })).toBe(T + 75_000);
  });
});

describe('accepted bids (properties)', () => {
  it('accepting only what decideBid accepts keeps bids strictly increasing and the funds limit', () => {
    fc.assert(fc.property(fc.array(fc.tuple(fc.integer({ min: 1, max: 6 }), fc.bigInt({ min: 0n, max: 400n * USDC }), fc.bigInt({ min: 0n, max: 300n * USDC })), { minLength: 1, maxLength: 40 }), (attempts) => {
      let highBid: bigint | null = null; let highBidder: string | null = null;
      const accepted: bigint[] = [];
      for (const [who, amount, available] of attempts) {
        const r = decideBid(base({ lot: { highBid, highBidderId: highBidder }, bidder: { profileId: `p${who}`, wallet: `W${who}` }, amount, available }));
        if (r.ok) {
          expect(amount).toBeLessThanOrEqual(available);
          if (highBid !== null) expect(amount).toBeGreaterThan(highBid);
          accepted.push(amount); highBid = amount; highBidder = `p${who}`;
        }
      }
      for (let n = 1; n < accepted.length; n++) expect(accepted[n]).toBeGreaterThan(accepted[n - 1]);
    }));
  });
  it('minNextBid is opening when nothing has bid, else high + increment', () => {
    fc.assert(fc.property(fc.bigInt({ min: 1n, max: 10n ** 9n }), fc.bigInt({ min: 1n, max: 10n ** 7n }), fc.option(fc.bigInt({ min: 1n, max: 10n ** 11n }), { nil: null }), (opening, increment, highBid) => {
      expect(minNextBid({ highBid, openingPrice: opening, increment })).toBe(highBid === null ? opening : highBid + increment);
    }));
  });
});

describe('outcomeAtClose', () => {
  it('sold at or above the reserve, passed below it or with no bid', () => {
    expect(outcomeAtClose({ highBid: 100n, reserve: 100n })).toBe('sold');
    expect(outcomeAtClose({ highBid: 99n, reserve: 100n })).toBe('passed');
    expect(outcomeAtClose({ highBid: null, reserve: null })).toBe('passed');
    expect(outcomeAtClose({ highBid: 1n, reserve: null })).toBe('sold');
  });
  it('equals hammerOutcome with requested "sold" for all inputs (property)', () => {
    const big = fc.option(fc.bigInt({ min: 0n, max: 10n ** 12n }), { nil: null });
    fc.assert(fc.property(big, big, (highBid, reserve) => { expect(outcomeAtClose({ highBid, reserve })).toBe(hammerOutcome({ highBid, reserve, requested: 'sold' })); }));
  });
});

describe('decideTick', () => {
  const tick = (over: Partial<Omit<TickInput, 'show'>> & { show?: Partial<TickInput['show']> }): TickInput => ({
    now: T, openableLots: 3, lastClosedAt: null, openLot: null, ...over,
    show: { status: 'live', scheduledAt: null, rules: RULE_DEFAULTS, ...over.show },
  });
  it('a scheduled show goes live at its time and opens the first lot in the same tick', () => {
    expect(decideTick(tick({ show: { status: 'scheduled', scheduledAt: T + 1 } }))).toEqual([]);
    expect(decideTick(tick({ show: { status: 'scheduled', scheduledAt: null } }))).toEqual([]);
    expect(decideTick(tick({ show: { status: 'scheduled', scheduledAt: T } }))).toEqual([{ type: 'go_live' }, { type: 'open_next' }]);
  });
  it('closes a due lot; the next opens only once the gap has elapsed', () => {
    const open = { id: 'L1', closesAt: T - 1_000 };
    expect(decideTick(tick({ openLot: open }))).toEqual([{ type: 'close_lot', lotId: 'L1' }]); // gap (6 s from T-1 s) not over
    expect(decideTick(tick({ openLot: { id: 'L1', closesAt: T - 6_000 } }))).toEqual([{ type: 'close_lot', lotId: 'L1' }, { type: 'open_next' }]);
    expect(decideTick(tick({ openLot: { id: 'L1', closesAt: T } }))).toEqual([{ type: 'close_lot', lotId: 'L1' }]);
  });
  it('does nothing while a lot is running, or while the gap after a close has not elapsed', () => {
    expect(decideTick(tick({ openLot: { id: 'L1', closesAt: T + 1 } }))).toEqual([]);
    expect(decideTick(tick({ lastClosedAt: T - 5_999 }))).toEqual([]);
    expect(decideTick(tick({ lastClosedAt: T - 6_000 }))).toEqual([{ type: 'open_next' }]);
  });
  it('a lot that is not timed is never closed and blocks the next one', () => {
    expect(decideTick(tick({ openLot: { id: 'L1', closesAt: null }, lastClosedAt: T - 99_000 }))).toEqual([]);
  });
  it('the show ends when nothing is left, after the gap', () => {
    expect(decideTick(tick({ openableLots: 0, lastClosedAt: T - 6_000 }))).toEqual([{ type: 'end_show' }]);
    expect(decideTick(tick({ openableLots: 0, lastClosedAt: T - 1_000 }))).toEqual([]);
    expect(decideTick(tick({ openableLots: 0, openLot: { id: 'L9', closesAt: T - 9_000 } }))).toEqual([{ type: 'close_lot', lotId: 'L9' }, { type: 'end_show' }]);
  });
  it('an ended show only closes a lot that is still running and never opens or ends again', () => {
    expect(decideTick(tick({ show: { status: 'ended' }, openLot: { id: 'L1', closesAt: T - 1 } }))).toEqual([{ type: 'close_lot', lotId: 'L1' }]);
    expect(decideTick(tick({ show: { status: 'ended' } }))).toEqual([]);
  });
  it('a full show plays out scheduled -> live -> lots -> ended, one action set per moment', () => {
    // Simulated store applying the actions, the way advanceShow does.
    const rules = resolveRules({ lotDurationS: 10, gapS: 2 });
    const st = { status: 'scheduled' as 'scheduled' | 'live' | 'ended', open: null as { id: string; closesAt: number } | null, left: 2, lastClosed: null as number | null, n: 0 };
    const log: string[] = [];
    for (let now = T; now <= T + 60_000; now += 500) {
      const acts = decideTick({ now, show: { status: st.status, scheduledAt: T, rules }, openLot: st.open, openableLots: st.left, lastClosedAt: st.lastClosed });
      for (const a of acts) {
        if (a.type === 'go_live') st.status = 'live';
        if (a.type === 'close_lot') { st.lastClosed = st.open!.closesAt; st.open = null; log.push('close'); }
        if (a.type === 'open_next') { st.open = { id: `L${++st.n}`, closesAt: now + 10_000 }; st.left--; log.push('open'); }
        if (a.type === 'end_show') { st.status = 'ended'; log.push('end'); }
      }
      // applying the actions makes the same instant a no-op (idempotent)
      const again = decideTick({ now, show: { status: st.status, scheduledAt: T, rules }, openLot: st.open, openableLots: st.left, lastClosedAt: st.lastClosed });
      expect(again).toEqual([]);
      if (st.status === 'ended') break;
    }
    expect(log).toEqual(['open', 'close', 'open', 'close', 'end']);
  });
});
