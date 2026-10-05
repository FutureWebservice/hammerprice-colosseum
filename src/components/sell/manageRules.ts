/**
 * The manage page's rules as pure functions. The server is the authority (ENGINE's controlLot refuses a
 * withdraw after the first bid with `wrong_state`); these only decide which buttons to offer, and the page
 * shows the server's answer when it disagrees.
 */
import type { CatalogueLot, LiveSnapshot, ShowPause } from '@/contracts/api';
import { PAUSE_MIN_LEFT_MS } from '@/lib/auction/rules';
import type { LotState, ShowStatus } from '@/contracts/common';

export interface LotRow {
  id: string;
  lotNumber: number;
  name: string;
  imageUrl: string | null;
  grade: string | null;
  reserve: string | null;
  openingPrice: string;
  increment: string;
  consignStatus: CatalogueLot['consignStatus'];
  state: LotState;
  bidCount: number;
  highBid: string | null;
  closesAt: string | null;
}

/** Catalogue (what the seller set) plus the snapshot (what the room says right now). Without a snapshot a lot is catalogued with no bids. */
export function mergeLots(catalogue: CatalogueLot[], snapshot: LiveSnapshot | null): LotRow[] {
  const live = new Map((snapshot?.lots ?? []).map((l) => [l.id, l]));
  return catalogue
    .map((c) => {
      const l = live.get(c.id);
      return {
        id: c.id, lotNumber: c.lotNumber, name: c.name, imageUrl: c.imageUrl, grade: c.grade,
        reserve: c.reserve, openingPrice: c.openingPrice, increment: c.increment, consignStatus: c.consignStatus,
        state: (l?.state ?? 'catalogued') as LotState, bidCount: l?.bidCount ?? 0, highBid: l?.highBid ?? null, closesAt: l?.closesAt ?? null,
      };
    })
    .sort((a, b) => a.lotNumber - b.lotNumber);
}

/** Withdraw and extend are allowed only while the lot has no bid (contract rule). */
export const canWithdraw = (l: LotRow) => (l.state === 'catalogued' || l.state === 'open') && l.bidCount === 0;
export const canExtend = (l: LotRow) => l.state === 'open' && l.bidCount === 0;
/** The reserve can change until the lot opens. */
export const canEditReserve = (l: LotRow) => l.state === 'catalogued';
/** A card that is not ready blocks "Start now" on the server (`lots_not_ready`); offer the re-check. */
export const needsReadiness = (l: LotRow) => l.state === 'catalogued' && l.consignStatus !== 'ready';

export const canStart = (status: ShowStatus) => status === 'scheduled';
export const canEnd = (status: ShowStatus) => status === 'live';
export const canCancel = (status: ShowStatus) => status === 'scheduled';

/** Seconds added by the extend button. The API allows 1 to 600. */
export const EXTEND_SECONDS = 30;

export type PauseGate = 'ok' | 'paused' | 'limit' | 'no_lot' | 'late' | 'unavailable';

/**
 * Whether the pause button is offered, from the snapshot (the server is the authority and answers `pause_limit`, `pause_too_late` or `lot_not_open`
 * when it disagrees). `serverNowMs` is the snapshot's own clock. Only a live room of the live kind can be paused.
 */
export function pauseGate(i: { status: ShowStatus; kind: 'live' | 'timed'; pause: ShowPause; openLotClosesAt: string | null; serverNowMs: number }): PauseGate {
  if (i.status !== 'live' || i.kind === 'timed') return 'unavailable';
  if (i.pause.paused) return 'paused';
  if (i.pause.used >= i.pause.max) return 'limit';
  if (!i.openLotClosesAt) return 'no_lot';
  return Date.parse(i.openLotClosesAt) - i.serverNowMs < PAUSE_MIN_LEFT_MS ? 'late' : 'ok';
}
