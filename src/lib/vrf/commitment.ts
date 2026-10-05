/**
 * What a request commits to, before any randomness exists: the parameters of the draw (plan part-core 3.3).
 * Builders validate and put the parameters in their one canonical order, so two honest parties always hash the same bytes.
 */
import { canonicalJson, paramsHashOf } from './canonical';
import { VrfError } from './types';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export interface LotRef { id: string; n: number }
export interface LotOrderParams { lots: LotRef[]; show: string; v: 1 }
export interface RaffleParams { entrants: number[]; show: string; v: 1 }
export interface PackEpochParams { epoch: string; oddsHash: string; packsHash: string; v: 1 }

const bad = (m: string): never => { throw new VrfError('bad_input', m); };
const uuid = (s: string, what: string) => { if (!UUID_RE.test(s)) bad(`${what} is not a lowercase uuid`); };
const posInt = (n: number, what: string) => { if (!Number.isSafeInteger(n) || n < 1) bad(`${what} must be a positive integer`); };

/** Lots sorted by their original number ascending; ids and numbers unique. */
export function lotOrderParams(show: string, lots: readonly LotRef[]): LotOrderParams {
  uuid(show, 'show');
  if (lots.length < 1) bad('a lot order needs at least one lot');
  const sorted = lots.map((l) => ({ id: l.id, n: l.n })).sort((a, b) => a.n - b.n);
  sorted.forEach((l) => { uuid(l.id, 'lot id'); posInt(l.n, 'lot number'); });
  if (new Set(sorted.map((l) => l.n)).size !== sorted.length || new Set(sorted.map((l) => l.id)).size !== sorted.length) bad('duplicate lot');
  return { lots: sorted, show, v: 1 };
}

/** Paddle numbers ascending, distinct. */
export function raffleParams(show: string, entrants: readonly number[]): RaffleParams {
  uuid(show, 'show');
  if (entrants.length < 1) bad('a raffle needs at least one entrant');
  const sorted = [...entrants].sort((a, b) => a - b);
  sorted.forEach((p) => posInt(p, 'paddle number'));
  if (new Set(sorted).size !== sorted.length) bad('duplicate entrant');
  return { entrants: sorted, show, v: 1 };
}

/** `epoch` is the UTC hour as ISO text, the two hashes are lowercase sha256 hex. */
export function packEpochParams(epoch: string, oddsHash: string, packsHash: string): PackEpochParams {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:00:00(?:\.000)?Z$/.test(epoch)) bad('epoch must be a UTC hour in ISO form');
  if (!HEX64.test(oddsHash) || !HEX64.test(packsHash)) bad('hashes must be sha256 hex');
  return { epoch, oddsHash, packsHash, v: 1 };
}

export interface Commitment { canonical: string; paramsHash: string }
/** The canonical text and its sha256 (hex) that go into the commit memo. */
export function commitmentOf(params: unknown): Commitment {
  return { canonical: canonicalJson(params), paramsHash: paramsHashOf(params) };
}
