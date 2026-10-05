'use client';

/**
 * The practice room's simulation: ticks a clock and asks src/lib/demo-clock.ts what the simulated sale looks
 * like right now, then reshapes that answer into the RoomLot / FeedItem shapes the room components draw, plus
 * the visitor / phase / msToNext indicators.
 *
 * EVERYTHING THIS HOOK RETURNS IS SIMULATED. It never calls an API route and never writes anywhere. Only
 * PracticeRoom imports it; a real room never does.
 *
 * Ticks once a second and stops while the tab is hidden so a backgrounded practice room does not burn battery.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { demoStateAt, type DemoClockLot, type DemoBidEvent, type DemoVisitorBid, type DemoLotState } from '@/lib/demo-clock';
import { useUsd } from '@/hooks/room/useUsd';
import { IDLE_VISITOR, type RoomLot, type FeedItem, type VisitorInfo, type RoomPhase } from './types';

const TICK_MS = 1_000;

export type DemoOverlay = {
  /** The lot id Stage/BidControl should treat as "current" - open, or hammered and pausing. */
  currentLotId: string | null;
  /** The catalogue lots with state, high bid and high bidder replaced by the simulated values; every
   *  other field (name, image, grading, reserve, increment...) is the real catalogue data. */
  lots: RoomLot[];
  /** Ready for EventRail as-is, newest first. */
  feed: FeedItem[];
  /** Places a wallet-connected visitor's bid on whichever lot is current right now - spliced
   *  into the clock's replay (see demo-clock.ts DemoVisitorBid) so it appears in the feed, lifts
   *  the high bid, and the simulation reacts to it exactly like it would to any other paddle
   *  (see demo-pacing.ts's shouldBid for the one deliberate exception: reduced odds while a
   *  visitor holds the bid, so they get a real shot at winning). A no-op if no lot is currently
   *  open. Never touches the network - see the module doc. */
  placeBid: (amount: bigint, wallet: string) => void;
  /** Holds the room where it stands while a visitor decides, and lets it catch up after.
   *  The bid panel is a modal over a sale that does not wait: opened on "going once" at $48,
   *  the hammer could fall while it was still on screen, and the bid confirmed a second later
   *  landed past the lot's conclusion, where demoStateAt has nothing left to splice it into.
   *  It vanished without a word. A real auctioneer holds for a raised paddle, so this one does
   *  too: while held, the clock stops advancing, the state under the panel is exactly the state
   *  the visitor is reading, and their bid lands against it. Releasing catches up to now. */
  setHold: (held: boolean) => void;
  /** Every lot this visitor has actually bid on, accumulated at the moment of the bid.
   *  WinModal needs this and cannot derive it: `visitor` describes only the lot that is current
   *  right now, and the room can move past a lot between the bid and the next render - which is
   *  exactly what happens when the clock catches up after the bid panel has been held open.
   *  A lot the visitor won was then never observed as current, so nothing celebrated it.
   *  Mutated in place; read inside an effect, never during render. */
  participatedLotIds: Set<string>;
  /** The visitor's own standing on the CURRENT lot only - see BidControl's VisitorInfo. */
  visitor: VisitorInfo;
  /** The room's auctioneer beat right now - see demo-clock.ts's DemoPhase. */
  phase: RoomPhase;
  /** ms until the next lot opens, valid while `phase` is 'hammered' or 'gap'. */
  msToNext: number | null;
};

function lotLabel(lotNumber: number) {
  return String(lotNumber).padStart(2, '0');
}

/** The visitor's status on whichever lot is current, from the sim's own view of that lot and
 *  whatever bid the visitor has recorded - see DemoVisitorBid's (cycleIndex, lotId) scoping in
 *  demo-clock.ts, mirrored here via `appliesToCurrent`. Passed lots get no dedicated wording:
 *  none of the five contract statuses cleanly says "you led but reserve wasn't met" (Stage's own
 *  line already covers that), so a visitor who led a passed lot reads as 'idle' rather than
 *  something misleading like "hammered to you". A visitor who was outbid before a lot passed
 *  still correctly reads as 'outbid'. */
function deriveVisitorInfo(currentLot: DemoLotState | undefined, appliesToCurrent: boolean, visitorBid: DemoVisitorBid | null, paddleLabel: (p: string | null) => string): VisitorInfo {
  if (!appliesToCurrent || !currentLot || !visitorBid) return IDLE_VISITOR;
  const lastAmount = visitorBid.amount;
  const mine = currentLot.highBidder === visitorBid.wallet;

  if (currentLot.state === 'open') {
    return mine
      ? { status: 'leading', lastAmount, outbidBy: null, hammer: null }
      : { status: 'outbid', lastAmount, outbidBy: { paddle: paddleLabel(currentLot.highBidder), amount: currentLot.highBid ?? BigInt(0) }, hammer: null };
  }
  if (currentLot.state === 'sold') {
    return mine
      ? { status: 'won', lastAmount, outbidBy: null, hammer: { amount: currentLot.highBid ?? BigInt(0), toVisitor: true } }
      : { status: 'lost', lastAmount, outbidBy: null, hammer: { amount: currentLot.highBid ?? BigInt(0), toVisitor: false } };
  }
  if (currentLot.state === 'passed' && !mine) {
    return { status: 'outbid', lastAmount, outbidBy: { paddle: paddleLabel(currentLot.highBidder), amount: currentLot.highBid ?? BigInt(0) }, hammer: null };
  }
  return { status: 'idle', lastAmount, outbidBy: null, hammer: null };
}

export default function useDemoRoom(lots: RoomLot[] | null): DemoOverlay | null {
  const t = useTranslations('room');
  const usd = useUsd();
  /** 'Paddle 07' (the simulated bidders) in the page language; anything else (the visitor) reads "You". */
  const paddleLabel = useCallback((p: string | null): string => {
    const m = p ? /^Paddle (\d+)$/.exec(p) : null;
    return m ? t('paddle.label', { number: Number(m[1]) }) : p ? t('feed.youFallback') : t('feed.bidderFallback');
  }, [t]);

  const clockLots = useMemo<DemoClockLot[] | null>(() => {
    if (!lots || lots.length === 0) return null;
    return lots.map((l) => ({
      id: l.id,
      lotNumber: l.lotNumber,
      opening: BigInt(l.openingPrice),
      increment: BigInt(l.increment),
      reserve: l.reserve != null ? BigInt(l.reserve) : null,
    }));
  }, [lots]);

  const [nowMs, setNowMs] = useState<number | null>(null);
  const [visitorBid, setVisitorBid] = useState<DemoVisitorBid | null>(null);
  // Updated every render so placeBid (called from an event handler, not a render) always sees
  // the cycle/lot the visitor is actually looking at, without needing to re-derive it itself.
  const cycleAndLotRef = useRef<{ cycleIndex: number; currentLotId: string | null; nowMs: number }>({ cycleIndex: 0, currentLotId: null, nowMs: 0 });
  // While true the clock stops advancing - see setHold on DemoOverlay for why.
  const holdRef = useRef(false);
  // See participatedLotIds on DemoOverlay.
  const participatedRef = useRef<Set<string>>(new Set());

  const setHold = useCallback((held: boolean) => {
    holdRef.current = held;
    if (!held) setNowMs(Date.now());
  }, []);

  const placeBid = useCallback((amount: bigint, wallet: string) => {
    const { cycleIndex, currentLotId, nowMs: shownAt } = cycleAndLotRef.current;
    if (currentLotId == null) return;
    // The bid lands at the moment the visitor was actually looking at, not at Date.now().
    // Those differ whenever the clock has been paused: the interval stops while the tab
    // reports hidden, so a visitor returning to a backgrounded room, or one whose window
    // never counted as visible at all, sees a state minutes behind the wall clock. A bid
    // stamped "now" then sits in that state's future, past the window demoStateAt is
    // replaying, and gets dropped without a word - the room still says "outbid", because the
    // bid is stored, it just never happened. Clamping to the shown moment makes the bid land
    // against the state it was actually placed against.
    // Recorded HERE, not from a later render's `visitor` status: after the catch-up below the
    // room may already be on another lot, and this is the last moment at which "the visitor bid
    // on this lot" is knowable.
    participatedRef.current.add(currentLotId);
    setVisitorBid({ cycleIndex, lotId: currentLotId, atMs: Math.min(Date.now(), shownAt), amount, wallet });
    // ...and let the room catch up right after, so a stale clock corrects itself the moment
    // someone interacts with it rather than staying behind until the tab is focused.
    setNowMs(Date.now());
  }, []);

  useEffect(() => {
    if (!clockLots) return undefined;
    let id: ReturnType<typeof setInterval> | null = null;
    const tick = () => { if (!holdRef.current) setNowMs(Date.now()); };
    const start = () => { tick(); id = setInterval(tick, TICK_MS); };
    const stop = () => { if (id !== null) { clearInterval(id); id = null; } };

    // Read the clock once, unconditionally. Visibility gates the INTERVAL, never the first
    // reading: a room opened in a background tab (a cmd-click, or a window sitting behind
    // another) gets no visibilitychange to wait for, and gating the first tick as well left it
    // rendering an empty catalogue forever until something happened to focus it.
    tick();
    if (typeof document === 'undefined' || document.visibilityState === 'visible') {
      id = setInterval(tick, TICK_MS);
    }
    const onVisibility = () => {
      if (document.hidden) stop(); else start();
    };
    // Focus as well as visibility: a window that never reports hidden but sits behind another
    // still stops getting timer attention in some browsers, and a visitor who clicks back into
    // it should find the sale where it actually is, not where it was.
    const onFocus = () => { if (!document.hidden) start(); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
    };
  }, [clockLots]);

  return useMemo<DemoOverlay | null>(() => {
    if (!clockLots || !lots || nowMs === null) return null;

    const state = demoStateAt(nowMs, clockLots, visitorBid);
    cycleAndLotRef.current = { cycleIndex: state.cycleIndex, currentLotId: state.currentLotId, nowMs };
    const byId = new Map(state.lots.map((l) => [l.id, l]));
    const byLotNumber = new Map(state.lots.map((l) => [l.lotNumber, l]));

    const outLots: RoomLot[] = lots.map((l) => {
      const sim = byId.get(l.id);
      if (!sim) return l;
      return {
        ...l,
        state: sim.state,
        highBid: sim.highBid != null ? sim.highBid.toString() : null,
        highBidder: sim.highBidder != null ? paddleLabel(sim.highBidder) : null,
        highBidderIsMe: !!visitorBid && sim.highBidder === visitorBid.wallet,
      };
    });

    const feed: FeedItem[] = state.history.map((ev, i) => eventToFeedItem(ev, i, t, visitorBid, byLotNumber, paddleLabel, usd));

    const currentLot = state.currentLotId != null ? byId.get(state.currentLotId) : undefined;
    const visitorAppliesToCurrent = !!(visitorBid && currentLot && visitorBid.cycleIndex === state.cycleIndex && visitorBid.lotId === currentLot.id);
    const visitor = deriveVisitorInfo(currentLot, visitorAppliesToCurrent, visitorBid, paddleLabel);

    return {
      currentLotId: state.currentLotId,
      lots: outLots,
      feed,
      placeBid,
      setHold,
      participatedLotIds: participatedRef.current,
      visitor,
      phase: state.phase,
      msToNext: state.msToNext,
    };
  }, [clockLots, lots, nowMs, t, usd, paddleLabel, visitorBid, placeBid, setHold]);
}

function eventToFeedItem(
  ev: DemoBidEvent,
  i: number,
  t: ReturnType<typeof useTranslations>,
  visitorBid: DemoVisitorBid | null,
  byLotNumber: Map<number, DemoLotState>,
  paddleLabel: (p: string | null) => string,
  usd: (u: string | null | undefined) => string,
): FeedItem {
  const key = `demo-${ev.kind}-${ev.lotNumber}-${ev.atMs}-${i}`;
  if (ev.kind === 'bid') {
    const mine = !!visitorBid && ev.paddle === visitorBid.wallet;
    return { key, kind: 'bid', ts: ev.atMs, lotNumber: ev.lotNumber, amount: ev.amount.toString(), who: paddleLabel(ev.paddle), mine };
  }
  if (ev.kind === 'opened') {
    return { key, kind: 'opened', ts: ev.atMs, lotNumber: ev.lotNumber, text: t('feed.opened', { number: lotLabel(ev.lotNumber) }) };
  }
  if (ev.kind === 'going-once' || ev.kind === 'going-twice') {
    return { key, kind: ev.kind, ts: ev.atMs, lotNumber: ev.lotNumber, text: t(ev.kind === 'going-once' ? 'call.once' : 'call.twice') };
  }
  if (ev.kind === 'passed') {
    return { key, kind: 'passed', ts: ev.atMs, lotNumber: ev.lotNumber, text: t('feed.passed', { number: lotLabel(ev.lotNumber) }) };
  }
  // 'sold' - the winner's own name if it was the visitor, otherwise the paddle label as-is (see
  // "Los 04 zugeschlagen an Paddle 31: $70.00" / "...an Sie: $70.00" in the task this shipped for).
  const winner = byLotNumber.get(ev.lotNumber)?.highBidder;
  const buyer = winner && visitorBid && winner === visitorBid.wallet ? t('feed.buyerYou') : paddleLabel(winner ?? null);
  const text = t('feed.hammered', { number: lotLabel(ev.lotNumber), buyer, amount: usd(ev.kind === 'sold' ? ev.highBid?.toString() : undefined) });
  return { key, kind: 'sold', ts: ev.atMs, lotNumber: ev.lotNumber, text };
}
