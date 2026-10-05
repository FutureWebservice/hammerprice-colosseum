/**
 * Pure view model of a real room: catalogue + LiveSnapshot (+ the viewer's paddle) -> what the components draw.
 * No React, no i18n library: callers pass a `label` and a `t` function. Everything here is unit-tested.
 */
import { parseEventPayload, type LiveSnapshot, type LotPhase, type ShowDetail, type SnapshotEvent } from '@/contracts';
import { nextIncrement } from '@/lib/bidding';
import { IDLE_VISITOR, formatUsdc, type FeedItem, type RoomLot, type RoomPhase, type RoomShow, type VisitorInfo } from './types';

export type Tr = (key: string, values?: Record<string, string | number>) => string;
export interface Optimistic { lotId: string; amount: bigint }

const pad = (n: number) => String(n).padStart(2, '0');

export function roomPhaseOf(p: LotPhase | undefined): RoomPhase {
  switch (p) {
    case 'open': return 'open';
    case 'going_once': return 'going-once';
    case 'going_twice': return 'going-twice';
    case 'queued': case undefined: return 'gap';
    default: return 'hammered';
  }
}

export function roomShowOf(s: LiveSnapshot['show']): RoomShow {
  return { id: s.id, title: s.title, status: s.status, cluster: s.cluster, isHouse: s.isHouse, settlementMode: s.settlementMode, kind: s.kind, order: s.order, video: s.video };
}

/** Catalogue terms merged with live state. `myPaddle` marks the viewer's own high bid. */
export function buildRoomLots(catalogue: ShowDetail, snapshot: LiveSnapshot | null, label: (paddle: number) => string, myPaddle: number | null, isHouseBidder?: (paddle: number) => boolean): RoomLot[] {
  const live = new Map((snapshot?.lots ?? []).map((l) => [l.id, l]));
  return catalogue.lots.map((c): RoomLot => {
    const l = live.get(c.id);
    const paddle = l?.highBidder?.paddle ?? null;
    return {
      id: c.id, lotNumber: c.lotNumber, name: c.name, setName: c.setName, gradingCompany: c.gradingCompany, grade: c.grade,
      imageUrl: c.imageUrl, insuredValue: c.insuredValue, reserve: c.reserve, increment: c.increment, openingPrice: c.openingPrice,
      state: l?.state ?? 'catalogued',
      highBid: l?.highBid ?? null,
      highBidder: paddle != null ? label(paddle) : null,
      highBidderIsMe: paddle != null && paddle === myPaddle,
      houseWon: l?.state === 'sold' && paddle != null && !!isHouseBidder?.(paddle),
      bidCount: l?.bidCount ?? 0,
      closesAt: l?.closesAt ?? null,
      settlement: l?.settlement,
      description: c.description,
      aiAssisted: c.aiAssisted,
    };
  });
}

/** Show the viewer's just-placed bid at once; it is dropped as soon as the server's high bid reaches it. */
export function applyOptimistic(lots: RoomLot[], o: Optimistic | null, myLabel: string): RoomLot[] {
  if (!o) return lots;
  return lots.map((l) => {
    if (l.id !== o.lotId || l.state !== 'open') return l;
    if (l.highBid != null && BigInt(l.highBid) >= o.amount) return l;
    return { ...l, highBid: o.amount.toString(), highBidder: myLabel, highBidderIsMe: true };
  });
}

/** Is the optimistic bid settled one way or the other (the server's high bid reached it, or the lot closed)? */
export function optimisticResolved(lots: RoomLot[], o: Optimistic | null): boolean {
  if (!o) return true;
  const l = lots.find((x) => x.id === o.lotId);
  return !l || l.state !== 'open' || (l.highBid != null && BigInt(l.highBid) >= o.amount);
}

/** The lot on stage: the server's current lot, else the next one waiting, else the last one closed. */
export function currentLotOf(lots: RoomLot[], snapshot: LiveSnapshot | null, showStatus: RoomShow['status']): RoomLot | null {
  const id = snapshot?.current?.lotId;
  const cur = id ? lots.find((l) => l.id === id) : undefined;
  if (cur) return cur;
  if (showStatus !== 'ended') {
    const next = lots.find((l) => l.state === 'catalogued') ?? lots.find((l) => l.state === 'open');
    if (next) return next;
  }
  return [...lots].reverse().find((l) => l.state === 'sold' || l.state === 'passed') ?? lots[0] ?? null;
}

/** The viewer's standing on `lot`. `bidOn` holds the lot ids the viewer has bid on in this room. */
export function visitorOf(lot: RoomLot | null, bidOn: ReadonlySet<string>): VisitorInfo {
  if (!lot || lot.highBid == null) return IDLE_VISITOR;
  const amount = BigInt(lot.highBid);
  const involved = bidOn.has(lot.id) || lot.highBidderIsMe;
  if (!involved) return IDLE_VISITOR;
  if (lot.state === 'open') {
    return lot.highBidderIsMe
      ? { status: 'leading', lastAmount: amount, outbidBy: null, hammer: null }
      : { status: 'outbid', lastAmount: null, outbidBy: { paddle: lot.highBidder ?? '', amount }, hammer: null };
  }
  if (lot.state === 'sold') {
    return lot.highBidderIsMe
      ? { status: 'won', lastAmount: amount, outbidBy: null, hammer: { amount, toVisitor: true } }
      : { status: 'lost', lastAmount: null, outbidBy: null, hammer: { amount, toVisitor: false } };
  }
  return IDLE_VISITOR;
}

export const nextBidOf = (lot: RoomLot | null): bigint | null =>
  lot && lot.state === 'open' ? nextIncrement(lot.highBid != null ? BigInt(lot.highBid) : null, BigInt(lot.openingPrice), BigInt(lot.increment)) : null;

/** Quick raises: the next bid plus 1, 2 and 5 times the lot's raise step. Each one is a legal bid (the server takes any amount at or above the minimum). */
export const quickBidsOf = (lot: RoomLot, next: bigint): bigint[] => [1n, 2n, 5n].map((k) => next + BigInt(lot.increment) * k);

export type BidGate = 'no_lot' | 'paused' | 'connect' | 'sign_in' | 'register' | 'ready' | 'leading';

/** What the big button does. One path in: connect, sign in, register a paddle, bid. */
export function bidGate(i: { lotOpen: boolean; connected: boolean; signedIn: boolean; hasPaddle: boolean; leading: boolean; /** The seller paused the room. */ paused?: boolean }): BidGate {
  if (!i.lotOpen) return 'no_lot';
  if (i.paused) return 'paused';
  if (i.leading) return 'leading';
  if (!i.connected) return 'connect';
  if (!i.signedIn) return 'sign_in';
  if (!i.hasPaddle) return 'register';
  return 'ready';
}

/** Feed rows from the accumulated events, newest first. Bidders appear as paddle labels only. */
export function feedFromEvents(events: readonly SnapshotEvent[], o: { label: (paddle: number) => string; myPaddle: number | null; t: Tr; isHouseBidder?: (paddle: number) => boolean }): FeedItem[] {
  const out: FeedItem[] = [];
  // A lot a house bot wins settles nothing (the engine lapses it at once, no strike): the hammer line says that instead of "sold to House bot".
  const houseWon = new Set<string>();
  for (const e of events) {
    if (e.kind !== 'lot.sold') continue;
    const p = parseEventPayload('lot.sold', e.payload);
    if (p && p.paddle != null && o.isHouseBidder?.(p.paddle)) houseWon.add(p.lotId);
  }
  const who = (paddle: number | null) => (paddle != null ? o.label(paddle) : o.t('feed.bidderFallback'));
  for (const e of events) {
    const ts = Date.parse(e.at);
    const key = `ev-${e.id}`;
    const num = (n: number) => pad(n);
    switch (e.kind) {
      case 'bid.placed': {
        const p = parseEventPayload('bid.placed', e.payload);
        if (p) out.push({ key, kind: 'bid', ts, lotNumber: p.lotNumber, amount: p.amount, who: who(p.paddle), mine: p.paddle != null && p.paddle === o.myPaddle });
        break;
      }
      case 'lot.opened': {
        const p = parseEventPayload('lot.opened', e.payload);
        if (p) out.push({ key, kind: 'opened', ts, lotNumber: p.lotNumber, text: o.t('feed.opened', { number: num(p.lotNumber) }) });
        break;
      }
      case 'lot.extended': {
        const p = parseEventPayload('lot.extended', e.payload);
        if (p) out.push({ key, kind: 'note', ts, lotNumber: p.lotNumber, text: o.t('feed.extended', { number: num(p.lotNumber) }) });
        break;
      }
      case 'lot.sold': {
        const p = parseEventPayload('lot.sold', e.payload);
        if (p) {
          if (houseWon.has(p.lotId)) { out.push({ key, kind: 'sold', ts, lotNumber: p.lotNumber, text: o.t('feed.houseWon', { number: num(p.lotNumber) }) }); break; }
          const buyer = p.paddle != null && p.paddle === o.myPaddle ? o.t('feed.buyerYou') : who(p.paddle);
          out.push({ key, kind: 'sold', ts, lotNumber: p.lotNumber, text: o.t('feed.hammered', { number: num(p.lotNumber), buyer, amount: formatUsdc(p.highBid) }) });
        }
        break;
      }
      case 'lot.passed': {
        const p = parseEventPayload('lot.passed', e.payload);
        if (p) out.push({ key, kind: 'passed', ts, lotNumber: p.lotNumber, text: o.t('feed.passed', { number: num(p.lotNumber) }) });
        break;
      }
      case 'lot.withdrawn': {
        const p = parseEventPayload('lot.withdrawn', e.payload);
        if (p) out.push({ key, kind: 'withdrawn', ts, lotNumber: p.lotNumber, text: o.t('feed.withdrawn', { number: num(p.lotNumber) }) });
        break;
      }
      case 'settlement.settled': {
        const p = parseEventPayload('settlement.settled', e.payload);
        if (p) out.push({ key, kind: 'note', ts, lotNumber: p.lotNumber, text: o.t('feed.settled', { number: num(p.lotNumber) }) });
        break;
      }
      case 'settlement.expired': {
        const p = parseEventPayload('settlement.expired', e.payload);
        // A house win was already said at the hammer.
        if (p && !houseWon.has(p.lotId)) out.push({ key, kind: 'note', ts, lotNumber: p.lotNumber, text: o.t('feed.notCompleted', { number: num(p.lotNumber) }) });
        break;
      }
      case 'show.paused': {
        const p = parseEventPayload('show.paused', e.payload);
        if (p) out.push({ key, kind: 'note', ts, lotNumber: p.lotNumber, text: o.t('feed.paused', { count: p.count, max: p.max }) });
        break;
      }
      case 'show.resumed': {
        const p = parseEventPayload('show.resumed', e.payload);
        if (p) out.push({ key, kind: 'note', ts, ...(p.lotNumber != null ? { lotNumber: p.lotNumber } : {}), text: o.t(p.auto ? 'feed.resumedAuto' : 'feed.resumed') });
        break;
      }
      case 'show.live': out.push({ key, kind: 'note', ts, text: o.t('feed.showLive') }); break;
      case 'show.ended': out.push({ key, kind: 'note', ts, text: o.t('feed.showEnded') }); break;
      default: break; // legacy or unknown kinds are not drawn
    }
  }
  return out.reverse();
}

/** Fraction of the bar still filled: msLeft over the largest window seen for this lot. */
export function countdownFraction(msLeft: number | null, peakMs: number): number {
  if (msLeft == null || peakMs <= 0) return 0;
  return Math.min(1, Math.max(0, msLeft / peakMs));
}
