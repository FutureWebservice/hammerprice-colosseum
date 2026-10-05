/**
 * From the 64-byte VRF output to one card, in public fixed steps (the same word stream as every other draw, lib/vrf/derive.ts):
 *
 *   1. Tiers that still hold at least one available card keep their published weight; the others drop out for this draw.
 *   2. roll = uniformInt(sum of the weights of the remaining tiers); the tier is found by walking the tiers in published order.
 *   3. position = the available cards of that tier in committed order, element uniformInt(count) of the SAME stream.
 *
 * With every tier in stock the weights are exactly the published odds. A tier that has sold out is simply absent, so the others
 * share its weight in proportion (the pack page says so). Nothing else influences the result.
 */
import { buildAlpha } from '@/lib/vrf/alpha';
import { fromHex } from '@/lib/vrf/bytes';
import { WordStream } from '@/lib/vrf/derive';
import type { ProofResult } from '@/lib/vrf/prove';
import type { Beacon } from '@/lib/vrf/types';
import type { Cluster } from '@/contracts';
import { drawParams, drawParamsHash, packDrawSubject, type DrawParams, type DrawPayment, type PackDefinition, type PackTierDef } from './commit';

export interface Selection {
  tier: string;
  /** Index in the committed card list. */
  position: number;
  /** The roll in [0, tierTotal) and the total it was drawn against (shown in the proof). */
  tierRoll: number;
  tierTotal: number;
  /** How many cards of that tier were available. */
  candidates: number;
}

export function selectFromPool(output: Uint8Array, odds: readonly PackTierDef[], cards: readonly { tier: string }[], taken: Iterable<number>): Selection | null {
  const gone = new Set(taken);
  const available = new Map<string, number[]>();
  cards.forEach((c, position) => {
    if (gone.has(position)) return;
    const list = available.get(c.tier);
    if (list) list.push(position); else available.set(c.tier, [position]);
  });
  const live = odds.filter((o) => (available.get(o.tier)?.length ?? 0) > 0);
  const tierTotal = live.reduce((n, o) => n + o.bps, 0);
  if (tierTotal === 0) return null;
  const stream = new WordStream(output);
  const tierRoll = stream.uniformInt(tierTotal);
  let acc = 0;
  let tier = live[live.length - 1]!;
  for (const o of live) {
    acc += o.bps;
    if (tierRoll < acc) { tier = o; break; }
  }
  const pool = available.get(tier.tier)!;
  const position = pool[stream.uniformInt(pool.length)]!;
  return { tier: tier.tier, position, tierRoll, tierTotal, candidates: pool.length };
}

// ---- making one draw (the server's side; takes the prover as a function so this file stays free of keys) -------------------------


export interface MadeDraw {
  params: DrawParams;
  paramsHash: string;
  alphaText: string;
  proof: ProofResult;
  selection: Selection | null;
}

/** Builds the parameters and the input text, proves, and derives the card. The VRF subject (and request row id) is `packDrawSubject(packId, index)`: nobody picks it. */
export function makeDraw(i: {
  cluster: Cluster;
  packId: string;
  poolHash: string;
  def: Pick<PackDefinition, 'odds' | 'cards'>;
  buyer: string;
  seed: string;
  index: number;
  taken: Iterable<number>;
  beacon: Beacon;
  /** Pay-first: the finalized payment this draw follows (its signature is hashed into the VRF input; the beacon must be after its slot). */
  payment?: DrawPayment;
  prove: (alphaText: string) => ProofResult;
}): MadeDraw {
  if (i.payment && i.beacon.slot <= i.payment.slot) throw new RangeError('the beacon must be a block after the payment');
  const params = drawParams({ buyer: i.buyer, index: i.index, pack: i.packId, poolHash: i.poolHash, seed: i.seed, taken: i.taken, ...(i.payment ? { payment: i.payment } : {}) });
  const paramsHash = drawParamsHash(params);
  const alphaText = buildAlpha({ cluster: i.cluster, purpose: 'pack_pull', subject: packDrawSubject(i.packId, i.index), paramsHash, beacon: i.beacon });
  const proof = i.prove(alphaText);
  return { params, paramsHash, alphaText, proof, selection: selectFromPool(fromHex(proof.outputHex, 64), i.def.odds, i.def.cards, params.taken) };
}
