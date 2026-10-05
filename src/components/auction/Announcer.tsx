'use client';

/**
 * The room's own voice: a short-lived stack of announcements narrating what just happened, so a
 * visitor never has to read the event feed to know what is going on. Driven entirely off the
 * exact state BidControl already receives (the current lot, the visitor's standing, the
 * auctioneer's beat) - nothing here invents an event that isn't already true of that state.
 *
 * Mounted from BidControl.tsx (not AuctionRoom.tsx) because that is the one place both the demo
 * overlay's and every real room's lot/visitor/phase already converge - see BidControl's own
 * props. Positioned fixed (see announcer.css) so it renders above everything regardless of
 * where in the tree it mounts, and never over the bid slab it sits above.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useUsd } from '@/hooks/room/useUsd';
import type { RoomLot, RoomPhase, VisitorInfo } from './types';
import { lotLimit } from './limit';
import './announcer.css';

/** The room's beat as of one render - just the fields an announcement could ever depend on.
 *  Deliberately NOT the full RoomLot/VisitorInfo objects compared by reference: the demo clock
 *  hands back a new object every tick even when nothing actually changed, so comparing full
 *  objects would either miss real changes or fire on every tick. */
export interface AnnounceSnapshot {
  lot: RoomLot | null;
  visitor: VisitorInfo;
  phase: RoomPhase | undefined;
}

/** One thing that happened, described structurally rather than as text - text/tier/duration are
 *  derived in `describe` below, kept apart so the pure comparison logic needs no translator. */
export type AnnouncementEvent =
  | { kind: 'lot-open'; lotId: string; lotNumber: number; name: string; estimate: string | null }
  /** belowReserve: the seller took a near miss under the reserve (demo-clock.ts's
   *  SELLER_ACCEPTS_FLOOR) - derived by comparing the hammer price to the lot's own reserve
   *  below, never invented, so a visitor who wins under the number they were told to beat is
   *  told why, not left to wonder. */
  | { kind: 'hammer'; lotId: string; toVisitor: boolean; paddle: string | null; amount: string | null; belowReserve: boolean }
  | { kind: 'passed'; lotId: string; lotNumber: number }
  | { kind: 'call'; lotId: string; stage: 'once' | 'twice' }
  | { kind: 'lead'; lotId: string; amount: string }
  | { kind: 'outbid'; lotId: string; paddle: string; amount: string }
  | { kind: 'bid'; lotId: string; paddle: string; amount: string };

/** How many announcements can be on screen at once - a burst of bids must read as a rhythm, not
 *  become a wall of toasts. Two, not three: the feed already lists every bid in full, so a third
 *  simultaneous chip added no information and grew the stack down into the lot's own title. */
const MAX_STACK = 2;

/**
 * Pure: what the transition from `prev` to `next` says, if anything. Comparing by value (lot id/
 * state/highBid, phase, visitor status) rather than by object identity is what makes this safe
 * to call every second with a freshly-computed `next` and produce nothing when nothing actually
 * changed - see the module doc. Exported for the unit test.
 */
export function announcementsFor(prev: AnnounceSnapshot | null, next: AnnounceSnapshot): AnnouncementEvent[] {
  const lot = next.lot;
  if (!prev || !lot) return [];
  const prevLot = prev.lot;
  const out: AnnouncementEvent[] = [];

  // A different lot is now current - not on the very first snapshot (prevLot === null), which
  // would otherwise narrate "lot 1 opens" the instant the room finishes loading.
  if (prevLot != null && prevLot.id !== lot.id) {
    out.push({ kind: 'lot-open', lotId: lot.id, lotNumber: lot.lotNumber, name: lot.name, estimate: lotLimit(lot).value });
  }

  // Same lot, just concluded - the hammer, or the pass.
  if (prevLot != null && prevLot.id === lot.id && prevLot.state === 'open') {
    if (lot.state === 'sold') {
      const belowReserve = lot.reserve != null && lot.highBid != null && BigInt(lot.highBid) < BigInt(lot.reserve);
      out.push({ kind: 'hammer', lotId: lot.id, toVisitor: next.visitor.status === 'won', paddle: lot.highBidder ?? null, amount: lot.highBid ?? null, belowReserve });
    } else if (lot.state === 'passed') {
      out.push({ kind: 'passed', lotId: lot.id, lotNumber: lot.lotNumber });
    }
  }

  // The auctioneer's call is NOT announced here. LowerThird already renders "going once" across
  // the stage at full size the moment the phase turns; a chip repeating the same two words at
  // the same instant said nothing new and landed on top of the lot's own reserve line. The
  // 'call' kind stays in the type and in the renderer, so a caller that wants the chip can
  // still push one - this is the room's editorial choice, not a missing feature.

  // Same lot, the high bid moved - a paddle bid, or the visitor's own arriving / being passed.
  // The visitor-status edge (not just its current value) is what stops "you are leading" from
  // re-announcing every tick a visitor simply continues to lead.
  if (prevLot != null && prevLot.id === lot.id && prevLot.highBid !== lot.highBid && lot.highBid != null) {
    if (next.visitor.status === 'leading' && prev.visitor.status !== 'leading') {
      out.push({ kind: 'lead', lotId: lot.id, amount: lot.highBid });
    } else if (next.visitor.status === 'outbid' && prev.visitor.status !== 'outbid' && next.visitor.outbidBy) {
      out.push({ kind: 'outbid', lotId: lot.id, paddle: next.visitor.outbidBy.paddle, amount: next.visitor.outbidBy.amount.toString() });
    } else {
      out.push({ kind: 'bid', lotId: lot.id, paddle: lot.highBidder ?? '', amount: lot.highBid });
    }
  }

  return out.slice(0, MAX_STACK);
}

type Tier = 'quiet' | 'brass' | 'win' | 'urgent';
type RoomT = ReturnType<typeof useTranslations>;

function lotLabel(n: number) {
  return String(n).padStart(2, '0');
}

/** Structural event -> the house's own words, its visual weight, and how long it holds. Kept
 *  apart from announcementsFor so that pure comparison logic never needs a translator to test. */
function describe(ev: AnnouncementEvent, t: RoomT, usd: (u: string | null | undefined) => string): { text: string; tier: Tier; durationMs: number } {
  switch (ev.kind) {
    case 'lot-open':
      return { text: ev.estimate ? t('announce.lotOpen', { number: lotLabel(ev.lotNumber), name: ev.name, amount: usd(ev.estimate) }) : t('announce.lotOpenNoMinimum', { number: lotLabel(ev.lotNumber), name: ev.name }), tier: 'brass', durationMs: 4000 };
    case 'hammer': {
      const amount = usd(ev.amount);
      if (ev.belowReserve) {
        return ev.toVisitor
          ? { text: t('announce.hammerYouBelowReserve', { amount }), tier: 'win', durationMs: 8000 }
          : { text: t('announce.hammerOtherBelowReserve', { paddle: ev.paddle ?? '', amount }), tier: 'brass', durationMs: 8000 };
      }
      return ev.toVisitor
        ? { text: t('announce.hammerYou', { amount }), tier: 'win', durationMs: 8000 }
        : { text: t('announce.hammerOther', { paddle: ev.paddle ?? '', amount }), tier: 'brass', durationMs: 8000 };
    }
    case 'passed':
      return { text: t('announce.passed', { number: lotLabel(ev.lotNumber) }), tier: 'brass', durationMs: 4000 };
    case 'call':
      return { text: ev.stage === 'once' ? t('call.once') : t('call.twice'), tier: 'brass', durationMs: 6000 };
    case 'lead':
      return { text: t('announce.leading', { amount: usd(ev.amount) }), tier: 'brass', durationMs: 4000 };
    case 'outbid':
      return { text: t('announce.outbid', { paddle: ev.paddle, amount: usd(ev.amount) }), tier: 'urgent', durationMs: 4000 };
    case 'bid':
      return { text: t('announce.bid', { paddle: ev.paddle, amount: usd(ev.amount) }), tier: 'quiet', durationMs: 4000 };
  }
}

interface Slot { id: string; text: string; tier: Tier; }

let seq = 0;

export default function Announcer({ lot, visitor, phase }: { lot: RoomLot | null; visitor: VisitorInfo; phase?: RoomPhase }) {
  const t = useTranslations('room');
  const usd = useUsd();
  const [slots, setSlots] = useState<Slot[]>([]);
  const prevRef = useRef<AnnounceSnapshot | null>(null);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Fires only when one of these primitives actually changed - which is also exactly what
  // makes repeated identical ticks a no-op without announcementsFor needing to know about
  // React at all.
  useEffect(() => {
    const next: AnnounceSnapshot = { lot, visitor, phase };
    const events = announcementsFor(prevRef.current, next);
    prevRef.current = next;
    if (events.length === 0) return;

    setSlots((current) => {
      let updated = current;
      for (const ev of events) {
        const { text, tier, durationMs } = describe(ev, t, usd);
        seq += 1;
        const id = `a${seq}`;
        updated = [...updated, { id, text, tier }].slice(-MAX_STACK);
        const timer = setTimeout(() => {
          setSlots((s) => s.filter((x) => x.id !== id));
          timers.current.delete(id);
        }, durationMs);
        timers.current.set(id, timer);
      }
      return updated;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lot?.id, lot?.state, lot?.highBid, phase, visitor.status]);

  useEffect(() => {
    const map = timers.current;
    return () => { map.forEach(clearTimeout); };
  }, []);

  if (slots.length === 0) return null;

  return (
    <div className="hp-announce-stack" role="status" aria-live="polite">
      {slots.map((s) => (
        <div key={s.id} className={`hp-announce hp-announce--${s.tier}`}>{s.text}</div>
      ))}
    </div>
  );
}
