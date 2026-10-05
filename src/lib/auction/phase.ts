/**
 * The phase the room draws, derived from stored state plus the clock. Nothing here is stored.
 *
 * Open lots are timed by `closesAt`. A lot with `closesAt === null` is a legacy row that nobody times (the old
 * manual hammer): it stays `open` until someone closes it by hand, and never becomes going_once or hammered here.
 */
import type { LotPhase, LotState, SettlementStatus, ShowKind } from '@/contracts/common';
import type { AuctionRules } from './rules';

export interface PhaseInput {
  state: LotState;
  /** ms epoch; null for a lot that is not timed. */
  closesAt: number | null;
  closedAt: number | null;
  now: number;
  rules: AuctionRules;
  settlement?: { status: SettlementStatus } | null;
}

export function lotPhase(i: PhaseInput): LotPhase {
  switch (i.state) {
    case 'catalogued':
      return 'queued';
    case 'withdrawn':
      return 'withdrawn';
    case 'passed':
      return 'passed';
    case 'open': {
      if (i.closesAt === null) return 'open';
      const left = i.closesAt - i.now;
      if (left <= 0) return 'hammered'; // past the deadline, waiting for the lazy close
      if (left <= i.rules.callTwiceS * 1000) return 'going_twice';
      if (left <= i.rules.callOnceS * 1000) return 'going_once';
      return 'open';
    }
    case 'sold': {
      const since = i.closedAt === null ? Infinity : i.now - i.closedAt;
      if (since < i.rules.gapS * 1000) return 'hammered'; // the result stamp is still on screen
      switch (i.settlement?.status) {
        case 'awaiting_payment':
        case 'awaiting_seller':
          return 'sold_awaiting_payment';
        case 'submitted':
          return 'sold_paying';
        case 'settled':
          return 'settled';
        case 'expired':
        case 'failed':
          return 'lapsed';
        default:
          return 'hammered'; // legacy or practice row: sold, nothing to settle
      }
    }
  }
}

/** Milliseconds until the next lot may open; 0 when the gap has elapsed or nothing has closed yet. */
export function msToNextOpen(i: { lastClosedAt: number | null; now: number; rules: AuctionRules }): number {
  if (i.lastClosedAt === null) return 0;
  return Math.max(0, i.lastClosedAt + i.rules.gapS * 1000 - i.now);
}

/** A timed lot shows the going once / going twice call only in this last stretch (the rules call it from 5 minutes out, which is not theatre). */
export const TIMED_CALL_THEATER_MS = 10_000;

/**
 * What a room draws for a phase. A live show draws the phase as it is. A timed show draws the call only in its last 10 seconds: before that
 * `going_once` / `going_twice` (in either spelling) become `open` with `soon: true`, and the room says "ends soon" instead of chanting.
 */
export function timedDisplay<P extends string>(kind: ShowKind | undefined, phase: P, msLeft: number | null): { phase: P | 'open'; soon: boolean } {
  const call = phase === 'going_once' || phase === 'going_twice' || phase === 'going-once' || phase === 'going-twice';
  if (kind !== 'timed' || !call) return { phase, soon: false };
  return msLeft != null && msLeft <= TIMED_CALL_THEATER_MS ? { phase, soon: false } : { phase: 'open', soon: true };
}
