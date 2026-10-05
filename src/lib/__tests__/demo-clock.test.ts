import { describe, it, expect, vi } from 'vitest';
import { demoStateAt, DEMO_EPOCH_MS, GAP_MS, LOT_SLICE_MS, type DemoClockLot, type DemoRoomState } from '../demo-clock';

const usdc = (n: number) => BigInt(Math.round(n * 1_000_000));
const at = (ms: number) => DEMO_EPOCH_MS + ms;

/** 12 lots with varied opening/reserve, matching the shape (and reserve/opening ratio) of the
 *  multi-lot invariant test in demo-pacing.test.ts. Lots are sequential and variable-length
 *  now (see demo-clock.ts), so there's no fixed per-cycle length constant any more - tests that
 *  need one derive it with findCycleEndMs below instead of hardcoding it. */
const LOTS: DemoClockLot[] = Array.from({ length: 12 }, (_, i) => ({
  id: `lot-${i + 1}`,
  lotNumber: i + 1,
  opening: usdc(50 + i),
  increment: usdc(5),
  reserve: usdc(100 + i * 3),
}));

/** Finds the exact ms (absolute, epoch-relative) where the cycle containing `cycleStartMs`
 *  ends and the next one begins, by binary search on demoStateAt's own cycleIndex - the only
 *  thing that changes at that boundary. Replaces the old fixed CYCLE_LEN_MS: cycle length is
 *  now variable (sum of each lot's own conclusion time + GAP_MS), so tests derive it instead
 *  of hardcoding it. */
function findCycleEndMs(lots: readonly DemoClockLot[], cycleStartMs: number): number {
  const cycleIndex = demoStateAt(cycleStartMs, lots).cycleIndex;
  let lo = cycleStartMs;
  let hi = cycleStartMs + lots.length * (LOT_SLICE_MS + GAP_MS) + 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (demoStateAt(mid, lots).cycleIndex === cycleIndex) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Smallest ms (absolute) in [fromMs, upperBoundMs) where the given lot number is no longer
 *  'open' - i.e. the real moment it concluded. */
function findConcludeMs(lots: readonly DemoClockLot[], fromMs: number, upperBoundMs: number, lotNumber: number): number {
  let lo = fromMs;
  let hi = upperBoundMs;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const s = demoStateAt(mid, lots);
    const lot = s.lots.find((l) => l.lotNumber === lotNumber);
    if (lot && lot.state === 'open') lo = mid + 1; else hi = mid;
  }
  return lo;
}

function hammerEvent(state: DemoRoomState, lotNumber: number) {
  return state.history.find((e) => (e.kind === 'sold' || e.kind === 'passed') && e.lotNumber === lotNumber);
}
function openedEvent(state: DemoRoomState, lotNumber: number) {
  return state.history.find((e) => e.kind === 'opened' && e.lotNumber === lotNumber);
}

/** Smallest ms in [fromMs, upperBoundMs) where the given lot number's window has opened (its
 *  state leaves 'catalogued'). Lots run strictly in lotNumber order within a cycle, so unlike
 *  "is this lot currently on the block" (true, then false again once the next lot opens -
 *  not a boundary a binary search can find), "has this lot's window started yet" is monotonic:
 *  false until it opens, true for the rest of the cycle. */
function findLotOpenMs(lots: readonly DemoClockLot[], lotNumber: number, fromMs: number, upperBoundMs: number): number {
  let lo = fromMs;
  let hi = upperBoundMs;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const lot = demoStateAt(mid, lots).lots.find((l) => l.lotNumber === lotNumber)!;
    if (lot.state === 'catalogued') lo = mid + 1; else hi = mid;
  }
  return lo;
}

const CYCLE0_END_MS = findCycleEndMs(LOTS, DEMO_EPOCH_MS);
const CYCLE0_LEN_MS = CYCLE0_END_MS - DEMO_EPOCH_MS;
const LOT1_CONCLUDE_MS = findConcludeMs(LOTS, DEMO_EPOCH_MS, at(LOT_SLICE_MS), 1) - DEMO_EPOCH_MS;

describe('demoStateAt', () => {
  it('is deterministic: the same nowMs always produces the same output', () => {
    const nowMs = at(1_234_567);
    const a = demoStateAt(nowMs, LOTS);
    const b = demoStateAt(nowMs, LOTS);
    expect(a).toEqual(b);
  });

  it('is deterministic across a fresh module load', async () => {
    const nowMs = at(300_000);
    const first = demoStateAt(nowMs, LOTS);
    vi.resetModules();
    const { demoStateAt: reloaded } = await import('../demo-clock');
    const second = reloaded(nowMs, LOTS);
    expect(second).toEqual(first);
  });

  it('never has two lots open at once, sampled across an entire cycle', () => {
    for (let ms = 0; ms < CYCLE0_LEN_MS; ms += 2_000) {
      const state = demoStateAt(at(ms), LOTS);
      const openCount = state.lots.filter((l) => l.state === 'open').length;
      expect(openCount).toBeLessThanOrEqual(1);
    }
  });

  it('bids on a lot grow monotonically as time advances within its window', () => {
    let lastLotId: string | null = null;
    let lastHighBid = BigInt(-1);
    for (let ms = 0; ms < LOT1_CONCLUDE_MS; ms += 500) {
      const state = demoStateAt(at(ms), LOTS);
      const lot = state.lots.find((l) => l.id === state.currentLotId);
      if (!lot || lot.lotNumber !== 1) continue;
      if (lot.id !== lastLotId) { lastLotId = lot.id; lastHighBid = BigInt(-1); }
      const bid = lot.highBid ?? BigInt(0);
      expect(bid).toBeGreaterThanOrEqual(lastHighBid);
      lastHighBid = bid;
    }
  });

  it('bid history for a single lot is strictly increasing in amount and time', () => {
    const state = demoStateAt(at(LOT1_CONCLUDE_MS + 5_000), LOTS);
    const bids = state.history
      .filter((e): e is Extract<typeof e, { kind: 'bid' }> => e.kind === 'bid' && e.lotNumber === 1)
      .sort((a, b) => a.atMs - b.atMs);
    for (let i = 1; i < bids.length; i++) {
      expect(bids[i]!.atMs).toBeGreaterThan(bids[i - 1]!.atMs);
      expect(bids[i]!.amount).toBeGreaterThan(bids[i - 1]!.amount);
    }
  });

  it("wraps cleanly: the instant one cycle ends, the next cycle's first lot is freshly open", () => {
    const justBeforeWrap = demoStateAt(CYCLE0_END_MS - 1, LOTS);
    const lastLot = justBeforeWrap.lots.find((l) => l.lotNumber === 12)!;
    expect(['sold', 'passed']).toContain(lastLot.state);

    const atWrap = demoStateAt(CYCLE0_END_MS, LOTS);
    expect(atWrap.cycleIndex).toBe(justBeforeWrap.cycleIndex + 1);
    const firstLot = atWrap.lots.find((l) => l.lotNumber === 1)!;
    expect(firstLot.state).toBe('open');
    expect(firstLot.highBid).toBeNull();
    expect(atWrap.currentLotId).toBe(firstLot.id);
    expect(atWrap.lots.filter((l) => l.state === 'open').length).toBe(1);
  });

  it('produces both sold and passed outcomes across many cycles', () => {
    const outcomes = new Set<string>();
    let cycleStart = DEMO_EPOCH_MS;
    for (let cycle = 0; cycle < 15; cycle++) {
      const cycleEnd = findCycleEndMs(LOTS, cycleStart);
      const state = demoStateAt(cycleEnd - 1, LOTS);
      for (const lot of state.lots) outcomes.add(lot.state);
      cycleStart = cycleEnd;
    }
    expect(outcomes.has('sold')).toBe(true);
    expect(outcomes.has('passed')).toBe(true);
  });

  it('every lot in a full cycle ends up sold or passed, never stuck catalogued', () => {
    const state = demoStateAt(CYCLE0_END_MS - 1, LOTS);
    for (const lot of state.lots) {
      expect(['sold', 'passed']).toContain(lot.state);
    }
  });

  it('handles an empty lot list without throwing', () => {
    const state = demoStateAt(Date.now(), []);
    expect(state).toEqual({ cycleIndex: 0, currentLotId: null, lots: [], history: [], phase: 'open', msToNext: null });
  });

  it('a nowMs before the epoch is a bounded fallback: cycle 0 at offset 0, not a crash or a negative-time result', () => {
    const state = demoStateAt(DEMO_EPOCH_MS - 1_000_000_000, LOTS);
    expect(state.cycleIndex).toBe(0);
    const firstLot = state.lots.find((l) => l.lotNumber === 1)!;
    expect(firstLot.state).toBe('open');
    expect(firstLot.highBid).toBeNull();
  });
});

describe('demoStateAt - the hammer no longer waits out the window (main bug fix)', () => {
  it('stamps the sold/passed event at the real conclusion time, and the next lot opens exactly GAP_MS later', () => {
    // Walk every lot-to-lot transition in cycle 0, sampling right as each one happens (so
    // HISTORY_LIMIT never has a chance to truncate the two events being compared - see
    // findLotOpenMs), and check the gap between one lot's hammer and the next lot's "opened"
    // stamp is always exactly GAP_MS - never up to LOT_SLICE_MS of dead air.
    let searchFrom = DEMO_EPOCH_MS;
    for (let lotNumber = 1; lotNumber < LOTS.length; lotNumber++) {
      const openMs = findLotOpenMs(LOTS, lotNumber + 1, searchFrom, CYCLE0_END_MS);
      const state = demoStateAt(openMs, LOTS);
      const hammer = hammerEvent(state, lotNumber);
      const nextOpened = openedEvent(state, lotNumber + 1);
      expect(hammer).toBeDefined();
      expect(nextOpened).toBeDefined();
      expect(nextOpened!.atMs - hammer!.atMs).toBe(GAP_MS);
      searchFrom = openMs;
    }
  });

  it('never sits on a settled lot for more than GAP_MS - msToNext right after the hammer is at most GAP_MS, never up to LOT_SLICE_MS', () => {
    const justAfter = demoStateAt(at(LOT1_CONCLUDE_MS), LOTS);
    const lot1 = justAfter.lots.find((l) => l.lotNumber === 1)!;
    expect(['sold', 'passed']).toContain(lot1.state);
    expect(justAfter.msToNext).not.toBeNull();
    expect(justAfter.msToNext!).toBeLessThanOrEqual(GAP_MS);
    expect(justAfter.msToNext!).toBeGreaterThan(0);
  });
});

describe('demoStateAt - phase and msToNext', () => {
  it('is "open" with no msToNext while a lot is freshly open and quiet', () => {
    const state = demoStateAt(at(500), LOTS);
    expect(state.phase).toBe('open');
    expect(state.msToNext).toBeNull();
  });

  it('calls "going once" / "going twice" before a lot concludes, visible while still open', () => {
    let sawGoingOnceOpen = false;
    let sawGoingTwiceOpen = false;
    let cycleStart = DEMO_EPOCH_MS;
    outer: for (let cycle = 0; cycle < 5 && !(sawGoingOnceOpen && sawGoingTwiceOpen); cycle++) {
      const cycleEnd = findCycleEndMs(LOTS, cycleStart);
      for (let ms = cycleStart; ms < cycleEnd; ms += 500) {
        const state = demoStateAt(ms, LOTS);
        const lot = state.lots.find((l) => l.id === state.currentLotId);
        if (!lot || lot.state !== 'open') continue;
        if (state.phase === 'going-once') sawGoingOnceOpen = true;
        if (state.phase === 'going-twice') sawGoingTwiceOpen = true;
        if (sawGoingOnceOpen && sawGoingTwiceOpen) break outer;
      }
      cycleStart = cycleEnd;
    }
    expect(sawGoingOnceOpen).toBe(true);
    expect(sawGoingTwiceOpen).toBe(true);
  });

  it('phase only ever moves forward through open -> going-once/twice -> hammered -> gap for a given lot, never backward', () => {
    const order: Record<string, number> = { open: 0, 'going-once': 1, 'going-twice': 2, hammered: 3, gap: 4 };
    let lastLotId: string | null = null;
    let lastRank = -1;
    for (let ms = 0; ms < CYCLE0_LEN_MS; ms += 500) {
      const state = demoStateAt(at(ms), LOTS);
      if (state.currentLotId !== lastLotId) { lastLotId = state.currentLotId; lastRank = -1; }
      const rank = order[state.phase]!;
      expect(rank).toBeGreaterThanOrEqual(lastRank);
      lastRank = rank;
    }
  });

  it('is "hammered" right after a lot concludes (a short fixed dwell), then "gap" until the next lot opens', () => {
    const justConcluded = demoStateAt(at(LOT1_CONCLUDE_MS), LOTS);
    expect(['sold', 'passed']).toContain(justConcluded.lots[0]!.state);
    expect(justConcluded.phase).toBe('hammered');

    const justBeforeGapEnds = demoStateAt(at(LOT1_CONCLUDE_MS + GAP_MS - 1), LOTS);
    expect(justBeforeGapEnds.phase).toBe('gap');
    expect(justBeforeGapEnds.msToNext).toBe(1);

    const nextOpen = demoStateAt(at(LOT1_CONCLUDE_MS + GAP_MS), LOTS);
    expect(nextOpen.phase).toBe('open');
    expect(nextOpen.lots[1]!.state).toBe('open');
  });

  it('msToNext counts down to exactly when the next lot opens', () => {
    for (let ms = 0; ms < CYCLE0_LEN_MS; ms += 5_000) {
      const state = demoStateAt(at(ms), LOTS);
      if (state.msToNext == null) continue;
      const next = demoStateAt(at(ms) + state.msToNext, LOTS);
      expect(next.phase).toBe('open');
    }
  });
});

describe('demoStateAt - sequential, variable-length lots', () => {
  it('the ceiling still forces a pass when a lot never goes quiet on its own', () => {
    // A reserve far out of reach keeps every round in the slow-continuing "below" bucket
    // (90% chance per round) - scan several cycles of this one lot's own seed until one of
    // them survives all the way to LOT_SLICE_MS without a natural conclusion.
    const stubbornLot: DemoClockLot = { id: 'stubborn', lotNumber: 1, opening: usdc(10), increment: usdc(1), reserve: usdc(100_000) };
    let cycleStart = DEMO_EPOCH_MS;
    let forced = false;
    for (let n = 0; n < 50 && !forced; n++) {
      const justBefore = demoStateAt(cycleStart + LOT_SLICE_MS - 1, [stubbornLot]);
      const atCeiling = demoStateAt(cycleStart + LOT_SLICE_MS, [stubbornLot]);
      if (justBefore.lots[0]!.state === 'open' && atCeiling.lots[0]!.state === 'passed') {
        forced = true;
        expect(atCeiling.phase).toBe('hammered'); // the ceiling just landed
      }
      cycleStart = findCycleEndMs([stubbornLot], cycleStart);
    }
    expect(forced).toBe(true);
  });

  it("a visitor's bid on an earlier lot never moves a later lot's offset or the cycle length", () => {
    // Compare the whole show from lot 2 onward with and without a visitor bid on lot 1 - since
    // every later lot's window is computed from lot 1's own seed-only (visitor-free) natural
    // duration, everything about lot 2+ must be byte-identical either way.
    const clickMs = at(20_000);
    const before = demoStateAt(clickMs, LOTS);
    const lot1Before = before.lots.find((l) => l.lotNumber === 1)!;
    const visitorAmount = (lot1Before.highBid ?? LOTS[0]!.opening) + LOTS[0]!.increment;
    const visitorBid = { cycleIndex: before.cycleIndex, lotId: lot1Before.id, atMs: clickMs, amount: visitorAmount, wallet: 'VisitorWalletOffsetTest' };

    for (let ms = at(LOT1_CONCLUDE_MS + GAP_MS); ms < CYCLE0_END_MS; ms += 15_000) {
      const withoutVisitor = demoStateAt(ms, LOTS);
      const withVisitor = demoStateAt(ms, LOTS, visitorBid);
      const laterLotsWithout = withoutVisitor.lots.filter((l) => l.lotNumber >= 2);
      const laterLotsWith = withVisitor.lots.filter((l) => l.lotNumber >= 2);
      expect(laterLotsWith).toEqual(laterLotsWithout);
      expect(withVisitor.currentLotId).toBe(withoutVisitor.currentLotId);
      expect(withVisitor.phase).toBe(withoutVisitor.phase);
      expect(withVisitor.msToNext).toBe(withoutVisitor.msToNext);
    }
  });
});

describe('demoStateAt - visitor fairness (no automatic wall)', () => {
  it('a visitor can hold the high bid all the way to the end of the window, not just win by getting lucky on the hammer', () => {
    let heldToEnd = 0;
    let attempts = 0;
    for (let trial = 0; trial < 60; trial++) {
      const clickMs = 5_000 + trial * 1_000;
      if (clickMs >= LOT1_CONCLUDE_MS) break;
      const before = demoStateAt(at(clickMs), LOTS);
      const lot1 = before.lots.find((l) => l.lotNumber === 1)!;
      if (lot1.state !== 'open') continue;
      attempts++;
      const visitorAmount = (lot1.highBid ?? LOTS[0]!.opening) + LOTS[0]!.increment;
      const wallet = `VisitorWallet${trial}`;
      const visitorBid = { cycleIndex: before.cycleIndex, lotId: lot1.id, atMs: at(clickMs), amount: visitorAmount, wallet };
      const final = demoStateAt(at(LOT1_CONCLUDE_MS - 1), LOTS, visitorBid);
      const lot1Final = final.lots.find((l) => l.lotNumber === 1)!;
      if (lot1Final.highBidder === wallet) heldToEnd++;
    }
    expect(attempts).toBeGreaterThan(10);
    expect(heldToEnd).toBeGreaterThan(0);
  });
});

describe('demoStateAt - visitor bid overlay', () => {
  it('a visitor bid takes the high bid and shows as the highBidder immediately after landing', () => {
    const beforeMs = at(20_000);
    const before = demoStateAt(beforeMs, LOTS);
    const lot1Before = before.lots.find((l) => l.lotNumber === 1)!;
    expect(lot1Before.state).toBe('open');
    const visitorAmount = (lot1Before.highBid ?? LOTS[0]!.opening) + LOTS[0]!.increment;

    const visitorBid = { cycleIndex: before.cycleIndex, lotId: lot1Before.id, atMs: beforeMs, amount: visitorAmount, wallet: 'VisitorWallet111111111111111111' };
    const after = demoStateAt(beforeMs, LOTS, visitorBid);
    const lot1After = after.lots.find((l) => l.lotNumber === 1)!;
    expect(lot1After.highBid).toBe(visitorAmount);
    expect(lot1After.highBidder).toBe(visitorBid.wallet);
    expect(after.history.some((e) => e.kind === 'bid' && e.lotNumber === 1 && e.paddle === visitorBid.wallet && e.amount === visitorAmount)).toBe(true);
  });

  it("the simulation continues past a visitor bid and eventually outbids them, but never past the lot's precomputed window end", () => {
    const beforeMs = at(20_000);
    const before = demoStateAt(beforeMs, LOTS);
    const lot1Before = before.lots.find((l) => l.lotNumber === 1)!;
    const visitorAmount = (lot1Before.highBid ?? LOTS[0]!.opening) + LOTS[0]!.increment;
    const visitorBid = { cycleIndex: before.cycleIndex, lotId: lot1Before.id, atMs: beforeMs, amount: visitorAmount, wallet: 'VisitorWallet111111111111111111' };

    const later = demoStateAt(at(LOT1_CONCLUDE_MS + GAP_MS - 1), LOTS, visitorBid);
    const lot1Later = later.lots.find((l) => l.lotNumber === 1)!;
    expect(['sold', 'passed']).toContain(lot1Later.state);
    expect(lot1Later.highBid! >= visitorAmount).toBe(true);
    if (lot1Later.highBidder !== visitorBid.wallet) {
      const bids = later.history.filter((e): e is Extract<typeof e, { kind: 'bid' }> => e.kind === 'bid' && e.lotNumber === 1).sort((a, b) => a.atMs - b.atMs);
      const visitorIdx = bids.findIndex((b) => b.paddle === visitorBid.wallet);
      expect(visitorIdx).toBeGreaterThanOrEqual(0);
      expect(bids[visitorIdx + 1]!.amount).toBeGreaterThan(visitorAmount);
    }
  });

  it("a bid from a different cycle never leaks into the current cycle's replay of the same lot", () => {
    const beforeMs = at(20_000);
    const before = demoStateAt(beforeMs, LOTS);
    const lot1 = before.lots.find((l) => l.lotNumber === 1)!;
    const staleVisitorBid = { cycleIndex: before.cycleIndex + 1, lotId: lot1.id, atMs: beforeMs, amount: BigInt(999_000_000), wallet: 'StaleWallet' };
    const withStale = demoStateAt(beforeMs, LOTS, staleVisitorBid);
    expect(withStale).toEqual(before);
  });
});

describe('a visitor bid never lands under the standing bid', () => {
  // The panel keeps the amount it opened with, and the room keeps running behind it. Splicing
  // that stale figure verbatim put a lower bid on top of a higher one, visible in the feed.
  it('raises a stale amount to the next legal increment', () => {
    const lots = Array.from({ length: 4 }, (_, i) => ({
      id: `l${i + 1}`, lotNumber: i + 1,
      opening: BigInt(24_000_000), increment: BigInt(6_000_000), reserve: BigInt(48_000_000),
    }));
    let checked = 0;
    for (let k = 0; k < 40; k++) {
      const t0 = DEMO_EPOCH_MS + k * 41_000 + 7_000;
      const s = demoStateAt(t0, lots);
      const cur = s.lots.find((l) => l.id === s.currentLotId);
      if (!cur || cur.state !== 'open') continue;
      // Deliberately stale: the opening price, long overtaken by the time it is confirmed.
      const stale = { cycleIndex: s.cycleIndex, lotId: cur.id, atMs: t0, amount: BigInt(1), wallet: 'VISITOR' };
      for (const dt of [500, 2_000, 5_000]) {
        const bids = demoStateAt(t0 + dt, lots, stale).history
          .filter((e) => e.kind === 'bid' && e.lotNumber === cur.lotNumber)
          .sort((a, b) => a.atMs - b.atMs) as Array<{ amount: bigint }>;
        for (let i = 1; i < bids.length; i++) {
          expect(bids[i]!.amount > bids[i - 1]!.amount).toBe(true);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });
});

describe('the cold start, which nothing used to measure', () => {
  // Both of these guard the same past bug from two sides. The epoch sat a year back, so the
  // very first demoStateAt of a page load walked 73,915 cycles: a measured 4.4-second freeze of
  // the browser's main thread on every cold load of the room, and ~92MB retained. Nothing caught
  // it, because the suite is epoch-relative by construction and the one Date.now() case here
  // passed an empty lot list, which returns before findCycle ever runs.
  const LOTS_12 = Array.from({ length: 12 }, (_, i) => ({
    id: `c${i + 1}`, lotNumber: i + 1,
    opening: usdc(20 + i * 3), increment: usdc(2 + (i % 3)), reserve: usdc(60 + i * 11),
  }));

  // A wall-clock assertion, so it flakes when vitest runs many files at once on a busy machine
  // (cold JIT, 250 to 330 ms seen). The assertion is unchanged; a real regression is seconds
  // slow and fails every attempt, so the retries only absorb noise.
  it('answers for the real wall clock in well under a frame budget', { retry: 3 }, () => {
    const started = performance.now();
    const state = demoStateAt(Date.now(), LOTS_12);
    const elapsed = performance.now() - started;
    expect(state.currentLotId).not.toBeNull();
    // Generous by two orders of magnitude against the 4,400ms this used to take: the point is to
    // fail loudly if the epoch is ever left a year behind again, not to police a few ms.
    expect(elapsed).toBeLessThan(250);
  });

  it('keeps the epoch in the past but near it', () => {
    const ageDays = (Date.now() - DEMO_EPOCH_MS) / 86_400_000;
    // In the past, or demoStateAt freezes the room at cycle 0 for every viewer.
    expect(ageDays).toBeGreaterThan(0);
    // And near it, because "which cycle is it now" is a walk, not arithmetic. A year of drift is
    // what caused the freeze; this fails while there is still time to move the epoch forward.
    expect(ageDays).toBeLessThan(120);
  });
});

describe('a lot a visitor won stays won, long after the room has moved on', () => {
  // The other half of the win-screen bug: the browser reads the visitor's win out of `lots`,
  // not out of a status edge, precisely because the clock can leave a lot between the bid and
  // the next render. If the lot did not keep reporting its winner, nothing could recover it.
  it('still names the visitor as the high bidder a full cycle later', () => {
    const lots = Array.from({ length: 4 }, (_, i) => ({
      id: `w${i + 1}`, lotNumber: i + 1,
      opening: usdc(24), increment: usdc(6), reserve: usdc(48),
    }));
    let found = 0;
    for (let k = 0; k < 60; k++) {
      const t0 = DEMO_EPOCH_MS + k * 37_000 + 5_000;
      const s = demoStateAt(t0, lots);
      const cur = s.lots.find((l) => l.id === s.currentLotId);
      if (!cur || cur.state !== 'open') continue;
      const bid = { cycleIndex: s.cycleIndex, lotId: cur.id, atMs: t0, amount: usdc(300), wallet: 'WINNER' };
      // Query far past the lot's own window, the way a caught-up clock does.
      const later = demoStateAt(t0 + 90_000, lots, bid);
      const mine = later.lots.find((l) => l.id === cur.id);
      if (mine?.state === 'sold' && mine.highBidder === 'WINNER') found++;
    }
    expect(found).toBeGreaterThan(5);
  });
});
