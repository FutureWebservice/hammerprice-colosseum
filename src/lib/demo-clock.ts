/**
 * The demo room's clock: a pure function of wall-clock time that answers "what is happening in
 * the demo show right now" - which lot is on the block, its state, the current high bid, and
 * the recent bid history. No I/O, no Date.now() inside (the caller passes nowMs), no stored
 * state - same input always produces the same output, which is what lets two judges opening the
 * room in the same minute see the same sale, and a page reload land back in the same lot at the
 * same price instead of a fresh one.
 *
 * Reuses demo-pacing.ts's pacing (step/pickPaddle/PADDLES - the browser-safe half of the old
 * demo-pacing.ts, split out so this file, and everything that imports it, never drags in
 * node:crypto or an Ed25519 library) rather than inventing new numbers, and bidding.ts /
 * auctioneer.ts's real rules (via step()'s own use of nextIncrement, and hammerOutcome here) so
 * a simulated sale obeys the same increments and reserve logic the real room does.
 *
 * Lots run SEQUENTIALLY and VARIABLE-LENGTH, one after another forever: lot i's bidding window
 * opens exactly GAP_MS after lot i-1's hammer falls, and lasts until its own replayed sale
 * concludes (or LOT_SLICE_MS forces a pass, whichever comes first). That "natural" duration
 * depends only on the lot's own seed (cycle, lot number) - never on a real visitor's bid - so
 * every later lot's offset, and the cycle's total length, stay deterministic and identical for
 * every visitor regardless of who bid on what. (Older revisions gave every lot the same fixed
 * LOT_SLICE_MS window and stamped the hammer at the window's end rather than the real
 * conclusion - the room then sat on a settled lot for up to a minute before moving on. This is
 * the fix.)
 *
 * cycle 0 is anchored at DEMO_EPOCH_MS. Finding which cycle nowMs falls in means walking cycles
 * forward from the epoch, which is only expensive the first time: each cycle's lot offsets/
 * durations are memoised in a module-level cache keyed by (lot set, cycle index), so a routine
 * 1s tick is a cache lookup plus a binary search, not a replay of the show's whole history.
 *
 * Within a lot's window, its bid sequence is replayed deterministically from a seed derived
 * from (cycle, lot number) using step() exactly as a live driver would. A real visitor's bid
 * can be spliced in and can extend the count (a counter-bid restarts it), but the lot still
 * ends by its precomputed natural-duration window end at the latest - see the comment on
 * `duration` in demoStateAt for what that trades away.
 */
import { step, pickPaddle, PADDLES, mulberry32, type LotContext } from './demo-pacing';
import { nextIncrement } from './bidding';
import { hammerOutcome } from './auctioneer';

export type DemoClockLot = {
  id: string;
  lotNumber: number;
  opening: bigint;
  increment: bigint;
  /** null = no reserve set, same convention as bidding.ts / auctioneer.ts. */
  reserve: bigint | null;
};

export type DemoLotState = {
  id: string;
  lotNumber: number;
  state: 'catalogued' | 'open' | 'sold' | 'passed';
  highBid: bigint | null;
  /** The paddle currently (or finally) holding the high bid, or null if none has bid yet. */
  highBidder: string | null;
};

export type DemoBidEvent =
  | { kind: 'opened'; lotNumber: number; atMs: number }
  | { kind: 'bid'; lotNumber: number; atMs: number; amount: bigint; paddle: string }
  | { kind: 'going-once' | 'going-twice'; lotNumber: number; atMs: number }
  | { kind: 'sold' | 'passed'; lotNumber: number; atMs: number; highBid: bigint | null };

/** The current lot's auctioneer beat - see useDemoRoom.ts's DemoOverlay contract, which this
 *  feeds directly. 'hammered' is a short fixed dwell (HAMMER_DWELL_MS) right after the hammer,
 *  so the sold/passed stamp is actually seen; 'gap' is the rest of the pause up to GAP_MS,
 *  right up to the next lot opening. */
export type DemoPhase = 'open' | 'going-once' | 'going-twice' | 'hammered' | 'gap';

export type DemoRoomState = {
  cycleIndex: number;
  /** The lot the room's centre stage should show: whichever one is open, or - during its pause
   *  - whichever one just hammered. null only when `lots` is empty. */
  currentLotId: string | null;
  /** Every lot's derived state as of nowMs, in lotNumber order. */
  lots: DemoLotState[];
  /** Every event that has happened so far this cycle, up to nowMs, newest first, capped. */
  history: DemoBidEvent[];
  /** The current lot's beat right now. 'open' (with no `currentLotId`) when `lots` is empty. */
  phase: DemoPhase;
  /** ms until the next lot opens - only meaningful while `phase` is 'hammered' or 'gap'. */
  msToNext: number | null;
};

/**
 * A real visitor's bid, to be spliced into the simulated sequence as if it were just another
 * paddle. Identified by (cycleIndex, lotId) so it only ever applies to the exact lot instance
 * it was placed on - the same lot recurs every cycle, and a bid placed in cycle N must not
 * leak into cycle N+1's replay of "lot 3".
 */
export type DemoVisitorBid = {
  cycleIndex: number;
  lotId: string;
  /** Wall-clock ms (Date.now() at click time) - where in the lot's window the bid lands. */
  atMs: number;
  amount: bigint;
  /** Shown in the feed exactly like a real bid's wallet - see EventRail/shortWallet. */
  wallet: string;
};

/** How long a lot's bidding window can run before it's forced to a conclusion either way - the
 *  hard ceiling, not the normal case (see `duration` in demoStateAt: most lots conclude well
 *  before this). */
export const LOT_SLICE_MS = 60_000;
/** The pause between one lot's hammer and the next lot opening. */
export const GAP_MS = 3_000;
/** How long the 'hammered' phase holds after the hammer before the phase becomes 'gap' - just
 *  long enough that a viewer actually sees the sold/passed stamp land. */
const HAMMER_DWELL_MS = 1_500;
/**
 * Cycle 0 starts here (2026-09-01T00:00:00Z). Every later cycle's start is derived by walking
 * forward from it, summing each cycle's own (variable) length - see findCycle.
 *
 * KEEP THIS CLOSE TO THE PRESENT. Because cycle lengths vary per cycle, "which cycle is it now"
 * cannot be computed in closed form: findCycle walks, once, on the first tick. The epoch used to
 * sit a year back, which made that first call replay 73,915 cycles - a measured 4.4 SECOND freeze
 * of the browser's main thread on every cold load of the room, and ~92MB retained in cache keys.
 * Everything after it was 0.05ms, so nothing downstream showed the cost and no test caught it
 * (the suite is epoch-relative by construction, and the one Date.now() case passes an empty lot
 * list, which returns before findCycle runs). A week back is ~2,000 cycles and ~25ms.
 *
 * It must stay in the PAST for every viewer, wherever they are: demoStateAt freezes the room at
 * cycle 0 for any nowMs before it. Move it forward again if this is still running months from
 * now - that is the maintenance this design trades for having no server.
 */
export const DEMO_EPOCH_MS = 1_788_220_800_000;
/** Defensive cap on the replay loop - a real lot always concludes in a handful of rounds (see
 *  demo-pacing.test.ts), this only guards against a future pacing bug spinning forever. */
const MAX_ROUNDS = 500;
/** How many recent events demoStateAt hands back - plenty for an event rail, cheap to compute. */
const HISTORY_LIMIT = 60;

/** Below this share of the reserve, a visitor's own high bid is simply too low: the lot passes.
 *  Above it the seller may take the near miss (see demoStateAt), the more likely the closer it
 *  got. Two thirds keeps the reserve meaningful while giving a visitor who bid seriously a real
 *  chance of taking the card home. */
const SELLER_ACCEPTS_FLOOR = 0.66;

/** cycle + lot number -> a 32-bit rng seed. Pure arithmetic, not crypto - this only needs to be
 *  a different number for every (cycle, lot) pair, not unguessable. */
function seedFor(cycleIndex: number, lotNumber: number): number {
  return ((cycleIndex * 2_654_435_761 + lotNumber * 40_503) >>> 0) || 1;
}

type RunState = {
  ctx: LotContext;
  lastPaddle: string | null;
  elapsed: number;
  concluded: boolean;
  /** How far into the "going once / going twice" call the room has gotten while waiting out the
   *  current hammer decision, 0 if none is in progress. Only ever set by the loop's one and only
   *  hammer-decision round (see below) - a fresh bid always supersedes it before another can
   *  start, so there is never more than one pending call per runRounds invocation. */
  callStage: 0 | 1 | 2;
};

/** Replays step() rounds from `state.elapsed` up to `toMs`, pushing bid events into `history` as
 *  they land. Pure continuation of whatever `rng` has already drawn - calling it twice with the
 *  same `rng` instance back-to-back (as demoStateAt does to splice in a visitor bid) is exactly
 *  the same sequence as one uninterrupted call over the combined range.
 *
 *  `visitorWallet` - non-null only once a visitor's own bid has been spliced in for this lot -
 *  is what lets step() (see demo-pacing.ts) tell a real visitor's held bid apart from a
 *  simulated paddle's, so it can chase the two at different odds (the fix for the "wall" bug:
 *  the room used to chase a visitor's bid exactly as eagerly as any paddle's).
 *
 *  When step() decides the room has gone quiet, the wait it hands back is split into three
 *  beats - "going once", "going twice", then the conclusion itself - instead of one silent gap,
 *  which is the fix for "no indicators": each beat only lands in `history` once its own moment
 *  has actually arrived, so a lot sitting mid-call re-renders as still-open-but-calling rather
 *  than jumping straight from open to closed. */
function runRounds(
  state: RunState,
  rng: () => number,
  toMs: number,
  cycleStartMs: number,
  windowStart: number,
  lotNumber: number,
  history: DemoBidEvent[],
  visitorWallet: string | null,
): RunState {
  let { ctx, lastPaddle, elapsed, concluded, callStage } = state;
  for (let round = 0; round < MAX_ROUNDS && !concluded; round++) {
    const visitorIsHighBidder = visitorWallet != null && lastPaddle === visitorWallet;
    // How far through the lot's own window this round falls. shouldBid reads it to give the
    // room its shape: crowded at the opening, quiet at the close, so a bidder who keeps going
    // takes the lot instead of being chased at the same odds forever.
    const result = step(ctx, rng, visitorIsHighBidder, elapsed / LOT_SLICE_MS);

    if (result.type === 'bid') {
      const eventAt = elapsed + result.delayMs;
      if (eventAt > toMs) break; // this step hasn't happened yet, from toMs's vantage point
      elapsed = eventAt;
      const paddle = pickPaddle(PADDLES, lastPaddle, rng);
      history.push({ kind: 'bid', lotNumber, atMs: cycleStartMs + windowStart + elapsed, amount: result.amount, paddle });
      ctx = { ...ctx, highBid: result.amount, bidsPlacedOnLot: ctx.bidsPlacedOnLot + 1 };
      lastPaddle = paddle;
      callStage = 0;
      continue;
    }

    // Quiet round: split the wait into going-once / going-twice / conclude rather than one
    // silent gap. This is always the LAST round this loop runs - it either concludes or breaks
    // (there is nothing left for step() to decide once the room has gone quiet).
    const d1 = Math.max(1, Math.floor(result.delayMs / 3));
    const d2 = Math.max(d1 + 1, Math.floor((result.delayMs * 2) / 3));
    const t1 = elapsed + d1;
    const t2 = elapsed + d2;
    const t3 = elapsed + result.delayMs;
    if (t1 > toMs) break;
    history.push({ kind: 'going-once', lotNumber, atMs: cycleStartMs + windowStart + t1 });
    callStage = 1;
    if (t2 > toMs) break;
    history.push({ kind: 'going-twice', lotNumber, atMs: cycleStartMs + windowStart + t2 });
    callStage = 2;
    if (t3 > toMs) break;
    elapsed = t3;
    concluded = true;
  }
  return { ctx, lastPaddle, elapsed, concluded, callStage };
}

// ---------------------------------------------------------------------------------------------
// Cycle layout: for each lot, how long its bidding window naturally runs (visitor-bid-free, so
// it depends only on the lot's own seed) and where that window starts within the cycle. This is
// what turns "fixed slots" into "sequential, variable-length lots" - see the module doc.
// ---------------------------------------------------------------------------------------------

type CycleLotWindow = { windowStart: number; duration: number };
type CycleLayout = { cycleStartMs: number; cycleLenMs: number; lots: CycleLotWindow[] };

/** cycle index -> its computed layout, keyed also by which lot set produced it (a fingerprint
 *  of ordered's ids/prices) so two different catalogues never share a cache entry. Grows only
 *  by appending - a cycle's layout never changes once computed, so nothing is ever evicted. */
const cycleLayoutCache = new Map<string, CycleLayout>();
/** Per lot-set: how many cycles (contiguous from 0) are already cached, and the wall-clock ms
 *  where the next uncached one would start - the frontier the forward walk resumes from. */
const frontier = new Map<string, { count: number; endMs: number }>();

/**
 * A short, stable key for a lot set.
 *
 * Hashed rather than spelled out because this string is a prefix of EVERY cycleLayoutCache key,
 * one per cycle: the spelled-out version ran to ~800 characters, so with a year of cycles behind
 * the epoch the keys alone accounted for most of ~92MB. FNV-1a plus the lot count and the source
 * length, which makes an accidental collision between two catalogues that would have to coexist
 * in one process vanishingly unlikely, and no correctness anywhere depends on the digest being
 * cryptographic.
 */
function lotsFingerprint(ordered: readonly DemoClockLot[]): string {
  let src = '';
  for (const l of ordered) src += `${l.id}:${l.lotNumber}:${l.opening}:${l.increment}:${l.reserve};`;
  let h = 0x811c9dc5;
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${ordered.length}.${src.length}.${(h >>> 0).toString(36)}`;
}

/** The natural (visitor-free) length of lot `ordered[i]`'s bidding window in cycle `cycleIndex`:
 *  however long its own replay takes to go quiet, capped at LOT_SLICE_MS. Depends only on the
 *  seed, never on what a real visitor does - that's what keeps later lots' offsets stable
 *  regardless of visitor bids (see demoStateAt's own use of `duration` below). */
function computeLotDuration(ordered: readonly DemoClockLot[], cycleIndex: number, i: number): number {
  const lot = ordered[i]!;
  const rng = mulberry32(seedFor(cycleIndex, lot.lotNumber));
  const ctx: LotContext = { highBid: null, opening: lot.opening, increment: lot.increment, reserve: lot.reserve, bidsPlacedOnLot: 0 };
  const run = runRounds({ ctx, lastPaddle: null, elapsed: 0, concluded: false, callStage: 0 }, rng, LOT_SLICE_MS, 0, 0, lot.lotNumber, [], null);
  return run.concluded ? run.elapsed : LOT_SLICE_MS;
}

function computeCycleLayout(ordered: readonly DemoClockLot[], cycleIndex: number, cycleStartMs: number): CycleLayout {
  let cursor = 0;
  const lots: CycleLotWindow[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const duration = computeLotDuration(ordered, cycleIndex, i);
    lots.push({ windowStart: cursor, duration });
    cursor += duration + GAP_MS;
  }
  return { cycleStartMs, cycleLenMs: cursor, lots };
}

/** Returns cycle `cycleIndex`'s layout, computing (and caching) every cycle from the current
 *  frontier up to and including it if it isn't cached yet. Only ever extends forward - callers
 *  always ask for cycles at or ahead of the frontier (see findCycle). */
function getCycleLayout(ordered: readonly DemoClockLot[], fp: string, cycleIndex: number): CycleLayout {
  const key = `${fp}#${cycleIndex}`;
  const cached = cycleLayoutCache.get(key);
  if (cached) return cached;
  let fr = frontier.get(fp) ?? { count: 0, endMs: DEMO_EPOCH_MS };
  while (fr.count <= cycleIndex) {
    const layout = computeCycleLayout(ordered, fr.count, fr.endMs);
    cycleLayoutCache.set(`${fp}#${fr.count}`, layout);
    fr = { count: fr.count + 1, endMs: fr.endMs + layout.cycleLenMs };
  }
  frontier.set(fp, fr);
  return cycleLayoutCache.get(key)!;
}

/** Finds the cycle containing nowMs, walking the frontier forward as far as needed (a few
 *  thousand cheap cycles, worst case, and only the first time nowMs is this far from the
 *  epoch) then binary-searching the now-cached cycles - so a routine 1s tick, landing in an
 *  already-known cycle, costs one lookup and a handful of comparisons, not a replay.
 *  nowMs before DEMO_EPOCH_MS is a bounded fallback: cycle 0 at offset 0 (see demoStateAt). */
function findCycle(ordered: readonly DemoClockLot[], fp: string, nowMs: number): { cycleIndex: number; layout: CycleLayout } {
  if (nowMs < DEMO_EPOCH_MS) return { cycleIndex: 0, layout: getCycleLayout(ordered, fp, 0) };

  let fr = frontier.get(fp);
  if (!fr) { getCycleLayout(ordered, fp, 0); fr = frontier.get(fp)!; }
  while (fr.endMs <= nowMs) {
    getCycleLayout(ordered, fp, fr.count);
    fr = frontier.get(fp)!;
  }

  let lo = 0;
  let hi = fr.count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const layout = cycleLayoutCache.get(`${fp}#${mid}`)!;
    if (layout.cycleStartMs <= nowMs) lo = mid; else hi = mid - 1;
  }
  return { cycleIndex: lo, layout: cycleLayoutCache.get(`${fp}#${lo}`)! };
}

export function demoStateAt(nowMs: number, lots: readonly DemoClockLot[], visitorBid?: DemoVisitorBid | null): DemoRoomState {
  const ordered = [...lots].sort((a, b) => a.lotNumber - b.lotNumber);
  if (ordered.length === 0) return { cycleIndex: 0, currentLotId: null, lots: [], history: [], phase: 'open', msToNext: null };

  const fp = lotsFingerprint(ordered);
  const { cycleIndex, layout } = findCycle(ordered, fp, nowMs);
  const cycleStartMs = layout.cycleStartMs;
  // Before the epoch there's no history to derive a position from - render as the very start
  // of cycle 0 rather than doing arithmetic on a negative age.
  const offset = nowMs < DEMO_EPOCH_MS ? 0 : nowMs - cycleStartMs;

  const lotStates: DemoLotState[] = [];
  const history: DemoBidEvent[] = [];
  let currentLotId: string | null = null;
  let phase: DemoPhase = 'open';
  let msToNext: number | null = null;

  for (let i = 0; i < ordered.length; i++) {
    const lot = ordered[i]!;
    // `duration` is this lot's natural, visitor-free window length (see computeLotDuration) -
    // it decides where every later lot's window starts, so it must never be influenced by a
    // real visitor's bid. It also caps how long THIS instance's own replay is allowed to run
    // below, visitor bid or not: a counter-bid can restart the "going once" count, but the lot
    // still ends by this precomputed window end at the latest. A visitor whose bid lands late
    // enough that a restarted count would have run past it simply gets a shorter count - an
    // accepted tradeoff for keeping every later lot's timing independent of what any one
    // visitor does.
    const { windowStart, duration } = layout.lots[i]!;
    const slotOffset = offset - windowStart;

    if (slotOffset < 0) {
      // Not called yet this cycle.
      lotStates.push({ id: lot.id, lotNumber: lot.lotNumber, state: 'catalogued', highBid: null, highBidder: null });
      continue;
    }

    currentLotId = lot.id;
    history.push({ kind: 'opened', lotNumber: lot.lotNumber, atMs: cycleStartMs + windowStart });

    const visibleMs = Math.min(slotOffset, duration);
    const rng = mulberry32(seedFor(cycleIndex, lot.lotNumber));
    const initialCtx: LotContext = { highBid: null, opening: lot.opening, increment: lot.increment, reserve: lot.reserve, bidsPlacedOnLot: 0 };

    // A visitor's bid only ever applies to the exact (cycle, lot) instance it was placed on -
    // see DemoVisitorBid's doc comment.
    const visitorApplies = visitorBid != null && visitorBid.cycleIndex === cycleIndex && visitorBid.lotId === lot.id;
    const visitorWallet = visitorApplies ? visitorBid!.wallet : null;
    const visitorRelMs = visitorApplies ? visitorBid!.atMs - cycleStartMs - windowStart : null;

    let run: RunState = { ctx: initialCtx, lastPaddle: null, elapsed: 0, concluded: false, callStage: 0 };
    if (visitorRelMs != null && visitorRelMs >= 0) {
      // Phase 1: replay exactly as usual, but only up to the moment the visitor clicked - this
      // is the same state the visitor actually saw and bid against.
      run = runRounds(run, rng, Math.min(visibleMs, visitorRelMs), cycleStartMs, windowStart, lot.lotNumber, history, visitorWallet);
      if (!run.concluded && visitorRelMs <= visibleMs) {
        // The amount is recomputed here, not taken as given. A visitor's stored bid was the
        // next increment at the moment their panel opened, and the room keeps running while
        // that panel is open: by the time it is confirmed the standing bid may already be
        // higher. Splicing the stored figure verbatim then put a LOWER bid on top of a higher
        // one, which the feed showed plainly and no auction would ever accept. Taking the
        // larger of the two means a visitor always bids at least the next legal increment
        // against whatever is actually standing, exactly as the slab promises.
        const legal = nextIncrement(run.ctx.highBid, lot.opening, lot.increment);
        const amount = visitorBid!.amount > legal ? visitorBid!.amount : legal;
        history.push({ kind: 'bid', lotNumber: lot.lotNumber, atMs: cycleStartMs + windowStart + visitorRelMs, amount, paddle: visitorBid!.wallet });
        run = {
          ctx: { ...run.ctx, highBid: amount, bidsPlacedOnLot: run.ctx.bidsPlacedOnLot + 1 },
          lastPaddle: visitorBid!.wallet,
          elapsed: visitorRelMs,
          concluded: false,
          callStage: 0, // a fresh bid cancels whatever call was in progress
        };
        // Phase 2: the same rng, continued - but now step() knows the high bid is the visitor's
        // own (see visitorWallet above), so the room no longer chases it at paddle-vs-paddle
        // odds. This is the fix for the reported "wall": a visitor now has a real, frequent
        // chance to hold the high bid all the way to the hammer instead of always being outbid
        // by the very next simulated round.
        run = runRounds(run, rng, visibleMs, cycleStartMs, windowStart, lot.lotNumber, history, visitorWallet);
      }
    } else {
      run = runRounds(run, rng, visibleMs, cycleStartMs, windowStart, lot.lotNumber, history, visitorWallet);
    }

    // The window forces a conclusion even if step() would have kept going: a lot that never
    // reaches reserve within its window passes rather than bidding forever.
    const concluded = run.concluded || slotOffset >= duration;

    if (concluded) {
      // hammerOutcome can also return 'withdrawn', but only when requested === 'withdrawn' -
      // never the case here, so this narrowing is safe (there is no "withdrawn" concept in the
      // simulation: nothing plays the seller's role to ask for one).
      let outcome = hammerOutcome({ highBid: run.ctx.highBid, reserve: lot.reserve, requested: 'sold' }) as 'sold' | 'passed';
      // A visitor who is still holding the high bid when the room goes quiet, but stopped short
      // of the reserve, would always lose the lot on the rule alone - which is why every bid a
      // real visitor placed ended in "nicht verkauft". Auction houses do not work that way: a
      // seller routinely accepts a near miss rather than carry the lot to the next sale. So a
      // visitor's own near miss gets that call, deterministically from this lot's seed, and the
      // closer they got the likelier the seller takes it. Below two thirds of the reserve it is
      // a pass, as it should be - the reserve has to mean something or winning means nothing.
      if (outcome === 'passed' && visitorWallet != null && run.lastPaddle === visitorWallet && run.ctx.highBid != null && lot.reserve != null) {
        const ratio = Number(run.ctx.highBid) / Number(lot.reserve);
        if (ratio >= SELLER_ACCEPTS_FLOOR) {
          const reach = (ratio - SELLER_ACCEPTS_FLOOR) / (1 - SELLER_ACCEPTS_FLOOR); // 0..1
          if (mulberry32(seedFor(cycleIndex, lot.lotNumber) ^ 0x5eed)() < 0.35 + reach * 0.5) {
            outcome = 'sold';
          }
        }
      }
      // The real moment the room went quiet for good - run.elapsed when step() itself decided
      // to conclude, or `duration` when the window's ceiling forced it instead. This is the
      // fix for the "long dead time" bug: the sold/passed stamp used to land at the window's
      // end (up to a minute later) instead of the actual hammer.
      const hammerElapsed = run.concluded ? run.elapsed : duration;
      lotStates.push({ id: lot.id, lotNumber: lot.lotNumber, state: outcome, highBid: run.ctx.highBid, highBidder: run.lastPaddle });
      history.push({ kind: outcome, lotNumber: lot.lotNumber, atMs: cycleStartMs + windowStart + hammerElapsed, highBid: run.ctx.highBid });
      const sinceHammer = slotOffset - hammerElapsed;
      // 'hammered': the short dwell right after the hammer, long enough to actually see the
      // stamp. 'gap': the rest of the pause, right up to the next lot's window starting - which
      // always begins exactly `duration + GAP_MS` after this one's, cycle wrap included (the
      // last lot's window end IS the next cycle's start - see computeCycleLayout).
      phase = sinceHammer < HAMMER_DWELL_MS ? 'hammered' : 'gap';
      msToNext = windowStart + duration + GAP_MS - offset;
    } else {
      lotStates.push({ id: lot.id, lotNumber: lot.lotNumber, state: 'open', highBid: run.ctx.highBid, highBidder: run.lastPaddle });
      phase = run.callStage === 1 ? 'going-once' : run.callStage === 2 ? 'going-twice' : 'open';
      msToNext = null;
    }
  }

  history.sort((a, b) => b.atMs - a.atMs);
  return { cycleIndex, currentLotId, lots: lotStates, history: history.slice(0, HISTORY_LIMIT), phase, msToNext };
}
