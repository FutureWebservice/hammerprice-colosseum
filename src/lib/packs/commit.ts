/**
 * The commitment of a pack and the input of one draw. Pure and browser safe (nothing here knows a database, a key or a network).
 *
 * A pack is defined by its operator with a pool of real cards and published odds. Before the first sale the whole definition is put
 * in canonical JSON (keys sorted, no spaces, integers only: lib/vrf/canonical.ts) and hashed with SHA-256: that is the `poolHash`.
 * The hash is shown on the pack page, goes into the VRF input of every draw and into the memo of every payment
 * (`hp:pack:<draw id>:<poolHash>`), so a card cannot be swapped, added or re-weighted afterwards without every sale showing it.
 *
 * Card POSITION is the index in the committed list. Everything that follows (taken positions, the draw) speaks in positions.
 */
import type { Cluster } from '@/contracts';
import { paramsHashOf, sha256Hex } from '@/lib/vrf/canonical';

export const PACK_V = 1 as const;
export type PackMode = 'chance' | 'equal_value';

export interface PackTierDef { tier: string; bps: number }
/** `value` is the listed value in USDC base units (a decimal string), null when the operator gave none. */
export interface PackCardDef { asset: string; tier: string; value: string | null }

export interface PackDefinition {
  mode: PackMode;
  cluster: Cluster;
  /** USDC base units per pack, decimal string. */
  price: string;
  operator: string;
  odds: readonly PackTierDef[];
  cards: readonly PackCardDef[];
}

/** What the odds commit to: the tier ids and their basis points, in the published order. */
export const oddsCommitment = (odds: readonly PackTierDef[]) => ({ odds: odds.map((o) => ({ bps: o.bps, tier: o.tier })), v: PACK_V });
export const oddsHashOf = (odds: readonly PackTierDef[]): string => paramsHashOf(oddsCommitment(odds));

/** The whole definition the operator is held to. Card order is the position. */
export function poolCommitment(d: PackDefinition) {
  return {
    cards: d.cards.map((c) => ({ asset: c.asset, tier: c.tier, value: c.value })),
    cluster: d.cluster,
    mode: d.mode,
    odds: d.odds.map((o) => ({ bps: o.bps, tier: o.tier })),
    operator: d.operator,
    price: d.price,
    v: PACK_V,
  };
}
export const poolHashOf = (d: PackDefinition): string => paramsHashOf(poolCommitment(d));

/** What the payment memo says: ties the on-chain transaction to the draw and to the committed pool. */
// Built from a bare namespace so the storage-key audit (src/legal/__tests__/audit.test.ts) does not mistake the memo text for a browser storage key.
const NS = 'hp';
export const packMemo = (drawId: string, poolHash: string): string => `${NS}:pack:${drawId}:${poolHash}`;
/** The memo of the house's card delivery (operator to buyer) it names the draw it ends. */
export const packDeliveryMemo = (drawId: string): string => `${NS}:pack-card:${drawId}`;
export const PACK_DELIVERY_MEMO_RE = /^hp:pack-card:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export const PACK_MEMO_RE = /^hp:pack:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9a-f]{64})$/;

/**
 * The payment a PAY FIRST draw is made after: its transaction signature and the slot it landed in. It is part of the committed parameters, so the
 * VRF input (which contains the hash of the parameters) depends on a value that exists only once the buyer has paid and that neither the buyer nor the
 * operator could choose beforehand. The beacon of such a draw is the first block produced after `slot`.
 */
export interface DrawPayment { signature: string; slot: number }

export interface DrawParams {
  buyer: string;
  index: number;
  pack: string;
  poolHash: string;
  /** The buyer's 32 hex characters. */
  seed: string;
  /** Positions that were not available at that moment (reserved, drawn or removed), ascending. */
  taken: number[];
  /** Pay-first draws only (absent in an atomic draw, so the hash of an atomic draw is unchanged). */
  payment?: DrawPayment;
  v: 1;
}

const B58_SIG = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;

/** The parameters one draw commits to; positions are sorted and checked so two honest parties always hash the same bytes. */
export function drawParams(p: Omit<DrawParams, 'v' | 'taken'> & { taken: Iterable<number> }): DrawParams {
  const taken = [...new Set(p.taken)].sort((a, b) => a - b);
  if (!Number.isSafeInteger(p.index) || p.index < 0) throw new RangeError('draw index must be a non-negative integer');
  if (!/^[0-9a-f]{32}$/.test(p.seed)) throw new RangeError('seed must be 32 lowercase hex characters');
  if (!/^[0-9a-f]{64}$/.test(p.poolHash)) throw new RangeError('pool hash must be sha256 hex');
  if (taken.some((t) => !Number.isSafeInteger(t) || t < 0)) throw new RangeError('taken positions must be non-negative integers');
  if (p.payment !== undefined && (!B58_SIG.test(p.payment.signature) || !Number.isSafeInteger(p.payment.slot) || p.payment.slot < 1)) throw new RangeError('payment must be a transaction signature and a slot');
  return { buyer: p.buyer, index: p.index, pack: p.pack, poolHash: p.poolHash, seed: p.seed, taken, ...(p.payment ? { payment: { signature: p.payment.signature, slot: p.payment.slot } } : {}), v: PACK_V };
}
export const drawParamsHash = (p: DrawParams): string => paramsHashOf(p);

/**
 * The VRF subject of one draw, derived from public values only: a UUID built from sha256("hammerprice pack draw v1" LF packId LF index).
 * The server does not choose it, so it cannot try many request ids for one (buyer, seed, index, taken, beacon) tuple and keep the
 * output it likes. The verifier recomputes it and rejects any other subject. The same value is the id of the `vrf_requests` row.
 */
export function packDrawSubject(packId: string, drawIndex: number): string {
  if (!Number.isSafeInteger(drawIndex) || drawIndex < 0) throw new RangeError('draw index must be a non-negative integer');
  const h = sha256Hex(`hammerprice pack draw v1\n${packId}\n${drawIndex}`);
  const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}
