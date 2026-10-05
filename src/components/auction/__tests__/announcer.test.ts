import { describe, it, expect } from 'vitest';
import { announcementsFor, type AnnounceSnapshot } from '../Announcer';
import type { RoomLot } from '../types';
import type { VisitorInfo } from '../types';

const IDLE: VisitorInfo = { status: 'idle', lastAmount: null, outbidBy: null, hammer: null };

function lot(over: Partial<RoomLot> = {}): RoomLot {
  return {
    id: 'lot-1',
    lotNumber: 1,
    name: 'Test Card',
    increment: '5000000',
    openingPrice: '50000000',
    highBid: null,
    highBidder: null,
    state: 'open',
    ...over,
  };
}

function snap(over: Partial<AnnounceSnapshot> = {}): AnnounceSnapshot {
  return { lot: lot(), visitor: IDLE, phase: 'open', ...over };
}

describe('announcementsFor', () => {
  it('announces nothing on the very first snapshot (no prior state to compare against)', () => {
    expect(announcementsFor(null, snap())).toEqual([]);
  });

  it('announces nothing when the state is unchanged, even across many repeated calls', () => {
    const a = snap({ lot: lot({ highBid: '52000000', highBidder: 'Paddle 31' }) });
    expect(announcementsFor(a, a)).toEqual([]);
    // A fresh object with identical values (exactly what the demo clock hands back every tick)
    // must be just as silent as the same reference.
    const b = snap({ lot: lot({ highBid: '52000000', highBidder: 'Paddle 31' }) });
    expect(announcementsFor(a, b)).toEqual([]);
  });

  it('announces a plain bid when the high bid moves and the visitor is not involved', () => {
    const prev = snap({ lot: lot({ highBid: null, highBidder: null }) });
    const next = snap({ lot: lot({ highBid: '52000000', highBidder: 'Paddle 31' }) });
    expect(announcementsFor(prev, next)).toEqual([
      { kind: 'bid', lotId: 'lot-1', paddle: 'Paddle 31', amount: '52000000' },
    ]);
  });

  it('announces the visitor leading, not a plain bid, the instant they take the high bid', () => {
    const prev = snap({ lot: lot({ highBid: '52000000', highBidder: 'Paddle 31' }), visitor: IDLE });
    const leading: VisitorInfo = { status: 'leading', lastAmount: BigInt(58_000_000), outbidBy: null, hammer: null };
    const next = snap({ lot: lot({ highBid: '58000000', highBidder: 'me' }), visitor: leading });
    expect(announcementsFor(prev, next)).toEqual([
      { kind: 'lead', lotId: 'lot-1', amount: '58000000' },
    ]);
  });

  it('does not re-announce leading on a later tick where the visitor is still leading', () => {
    const leading: VisitorInfo = { status: 'leading', lastAmount: BigInt(58_000_000), outbidBy: null, hammer: null };
    const a = snap({ lot: lot({ highBid: '58000000', highBidder: 'me' }), visitor: leading });
    const b = snap({ lot: lot({ highBid: '58000000', highBidder: 'me' }), visitor: leading });
    expect(announcementsFor(a, b)).toEqual([]);
  });

  it('announces outbid, not a plain bid, when another paddle overtakes the visitor', () => {
    const leading: VisitorInfo = { status: 'leading', lastAmount: BigInt(58_000_000), outbidBy: null, hammer: null };
    const outbid: VisitorInfo = { status: 'outbid', lastAmount: BigInt(58_000_000), outbidBy: { paddle: 'Paddle 44', amount: BigInt(64_000_000) }, hammer: null };
    const prev = snap({ lot: lot({ highBid: '58000000', highBidder: 'me' }), visitor: leading });
    const next = snap({ lot: lot({ highBid: '64000000', highBidder: 'Paddle 44' }), visitor: outbid });
    expect(announcementsFor(prev, next)).toEqual([
      { kind: 'outbid', lotId: 'lot-1', paddle: 'Paddle 44', amount: '64000000' },
    ]);
  });

  it('leaves the auctioneer\'s call to the lower third and announces nothing itself', () => {
    // LowerThird puts "going once" across the stage at full size the moment the phase turns.
    // A chip saying the same two words at the same instant added nothing and covered the lot's
    // own reserve line, so the phase edge deliberately produces no announcement at all.
    const prev = snap({ phase: 'open' });
    const once = snap({ phase: 'going-once' });
    expect(announcementsFor(prev, once)).toEqual([]);
    const twice = snap({ phase: 'going-twice' });
    expect(announcementsFor(once, twice)).toEqual([]);
  });

  it('announces the hammer, to the visitor when they won it', () => {
    const prev = snap({ lot: lot({ state: 'open', highBid: '70000000', highBidder: 'me' }), visitor: { status: 'leading', lastAmount: BigInt(70_000_000), outbidBy: null, hammer: null } });
    const won: VisitorInfo = { status: 'won', lastAmount: BigInt(70_000_000), outbidBy: null, hammer: { amount: BigInt(70_000_000), toVisitor: true } };
    const next = snap({ lot: lot({ state: 'sold', highBid: '70000000', highBidder: 'me' }), visitor: won });
    expect(announcementsFor(prev, next)).toEqual([
      { kind: 'hammer', lotId: 'lot-1', toVisitor: true, paddle: 'me', amount: '70000000', belowReserve: false },
    ]);
  });

  it('announces the hammer to a paddle, not the visitor, when someone else won it', () => {
    const prev = snap({ lot: lot({ state: 'open', highBid: '70000000', highBidder: 'Paddle 31' }) });
    const next = snap({ lot: lot({ state: 'sold', highBid: '70000000', highBidder: 'Paddle 31' }) });
    expect(announcementsFor(prev, next)).toEqual([
      { kind: 'hammer', lotId: 'lot-1', toVisitor: false, paddle: 'Paddle 31', amount: '70000000', belowReserve: false },
    ]);
  });

  it('marks the hammer belowReserve when the seller accepted a near miss under the lot\'s own reserve', () => {
    const prev = snap({ lot: lot({ state: 'open', reserve: '80000000', highBid: '70000000', highBidder: 'Paddle 31' }) });
    const next = snap({ lot: lot({ state: 'sold', reserve: '80000000', highBid: '70000000', highBidder: 'Paddle 31' }) });
    expect(announcementsFor(prev, next)).toEqual([
      { kind: 'hammer', lotId: 'lot-1', toVisitor: false, paddle: 'Paddle 31', amount: '70000000', belowReserve: true },
    ]);
  });

  it('announces a pass', () => {
    const prev = snap({ lot: lot({ state: 'open' }) });
    const next = snap({ lot: lot({ state: 'passed' }) });
    expect(announcementsFor(prev, next)).toEqual([{ kind: 'passed', lotId: 'lot-1', lotNumber: 1 }]);
  });

  it('announces a new lot opening, but not on the very first lot the room ever shows', () => {
    const firstEver = snap({ lot: lot({ id: 'lot-1' }) });
    expect(announcementsFor(null, firstEver)).toEqual([]);

    const prev = snap({ lot: lot({ id: 'lot-1', state: 'sold' }) });
    const next = snap({ lot: lot({ id: 'lot-2', lotNumber: 2, name: 'Next Card', state: 'open', reserve: '62500000' }) });
    expect(announcementsFor(prev, next)).toEqual([
      { kind: 'lot-open', lotId: 'lot-2', lotNumber: 2, name: 'Next Card', estimate: '62500000' },
    ]);
  });

  it('caps a burst of simultaneous events at three, in a stable priority order', () => {
    // Contrived: a lot change AND a hammer can never really coincide (see Announcer.tsx), but the
    // cap itself must hold regardless of how many independent conditions happen to fire.
    const prev = snap({ lot: lot({ id: 'lot-1', state: 'open', highBid: null }), phase: 'open' });
    const next = snap({ lot: lot({ id: 'lot-1', state: 'open', highBid: '52000000', highBidder: 'Paddle 31' }), phase: 'going-once' });
    const result = announcementsFor(prev, next);
    expect(result.length).toBeLessThanOrEqual(3);
  });
});
