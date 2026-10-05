/**
 * Kinds and payloads of the `show_events` rows the live snapshot carries.
 *
 * Kinds are written dot style from now on; ENGINE's `normalizeKind` maps the legacy underscore names
 * (`lot_opened`, `demo_reset`, ...). Payloads carry paddle numbers, NEVER wallet addresses.
 *
 * The snapshot's `events` array stays loosely typed (`kind: string`, free payload) because the six
 * legacy shows hold rows written before these shapes existed; new readers call `parseEventPayload`,
 * which returns null for a row that does not match instead of throwing.
 */
import { z } from 'zod';
import { Amount, IsoTime, TxSignature, Uuid } from './common';

const lot = { lotId: Uuid, lotNumber: z.number().int().min(1) };
/** The public bidder handle: a paddle number, or null when the bid came from a legacy row. */
const paddle = z.number().int().min(1).nullable();

export const EVENT_PAYLOADS = {
  'show.live': z.object({}).strict(),
  'show.ended': z.object({}).strict(),
  /**
   * The seller (or, on the house show, an operator) paused the room. Bids are refused until `resumesBy` at the latest; the open lot keeps
   * `msLeft` and gets it back on resume. `count` of `max` pauses are used. Public, so every bidder sees it in the feed.
   */
  'show.paused': z.object({ ...lot, resumesBy: IsoTime, msLeft: z.number().int().nonnegative(), count: z.number().int().min(1), max: z.number().int().min(1) }).strict(),
  /** The room is running again. `auto`: the 5 minute limit ended the pause. `shiftedMs`: how far the open lot's deadline moved (the paused time). */
  'show.resumed': z.object({ lotId: Uuid.nullable(), lotNumber: z.number().int().min(1).nullable(), closesAt: IsoTime.nullable(), shiftedMs: z.number().int().nonnegative(), auto: z.boolean() }).strict(),
  'lot.opened': z.object({ ...lot, closesAt: IsoTime }).strict(),
  'bid.placed': z.object({ ...lot, amount: Amount, paddle, belowReserve: z.boolean() }).strict(),
  'lot.extended': z.object({ ...lot, closesAt: IsoTime }).strict(),
  'lot.sold': z.object({ ...lot, highBid: Amount, paddle }).strict(),
  'lot.passed': z.object({ ...lot, highBid: Amount.nullable() }).strict(),
  'lot.withdrawn': z.object({ ...lot }).strict(),
  'settlement.awaiting': z.object({ ...lot, settlementId: Uuid, gross: Amount, dueAt: IsoTime }).strict(),
  'settlement.submitted': z.object({ ...lot, settlementId: Uuid, txSignature: TxSignature }).strict(),
  'settlement.settled': z.object({ ...lot, settlementId: Uuid, txSignature: TxSignature }).strict(),
  'settlement.expired': z.object({ ...lot, settlementId: Uuid }).strict(),
  /** The simulated practice room only (legacy `demo_reset`). */
  'demo.reset': z.object({}).strict(),
} as const;

export type EventKind = keyof typeof EVENT_PAYLOADS;
export const EVENT_KINDS = Object.keys(EVENT_PAYLOADS) as EventKind[];
export type EventPayload<K extends EventKind> = z.infer<(typeof EVENT_PAYLOADS)[K]>;

export const EventKindSchema = z.enum(EVENT_KINDS as [EventKind, ...EventKind[]]);

/** One row of `LiveSnapshot.events`. `id` is `show_events.id` (strictly increasing per show). */
export const SnapshotEvent = z
  .object({ id: z.number().int().nonnegative(), kind: z.string().min(1).max(64), at: IsoTime, payload: z.record(z.unknown()) })
  .strict();
export type SnapshotEvent = z.infer<typeof SnapshotEvent>;

/** Typed payload for a known kind, or null when the kind is unknown or the payload does not match (legacy rows). */
export function parseEventPayload<K extends EventKind>(kind: K, payload: unknown): EventPayload<K> | null {
  const r = EVENT_PAYLOADS[kind]?.safeParse(payload);
  return r?.success ? (r.data as EventPayload<K>) : null;
}
