/**
 * Shared types of the ECVRF library (RFC 9381, ECVRF-EDWARDS25519-SHA512-TAI). Pure: no I/O, browser safe.
 */
import type { Cluster } from '@/contracts';

/**
 * Mirror of CLUSTERS in lib/chain/config.ts, kept here because that module drags the whole zod contract bundle (about
 * 70 KB) into the browser verifier. The Record type makes the compiler reject a missing or extra cluster, and a test
 * pins it to CLUSTERS.
 */
const CLUSTER_SET: Record<Cluster, true> = { devnet: true, 'mainnet-beta': true };
export const isCluster = (v: unknown): v is Cluster => typeof v === 'string' && Object.prototype.hasOwnProperty.call(CLUSTER_SET, v);
export const CLUSTER_LIST = Object.keys(CLUSTER_SET) as Cluster[];

export const SUITE_NAME = 'ECVRF-EDWARDS25519-SHA512-TAI';

/** What a request is for. `pack_epoch` is the request purpose of the pack demo; its alphas say `pack_pull`. */
export type VrfPurpose = 'lot_order' | 'raffle' | 'pack_epoch';
/** The purpose line inside the signed alpha text. */
export type AlphaPurpose = 'lot_order' | 'raffle' | 'pack_pull';
export type VrfStatus = 'pending' | 'committed' | 'revealed' | 'defaulted';

export const ALPHA_PURPOSE_OF: Record<VrfPurpose, AlphaPurpose> = {
  lot_order: 'lot_order',
  raffle: 'raffle',
  pack_epoch: 'pack_pull',
};

export interface Beacon {
  slot: number;
  /** base58 blockhash of `slot` */
  blockhash: string;
}

/** The public face of one request, exactly what GET /api/vrf/requests/:id returns (no tx bytes, no lease). */
export interface VrfRequestView {
  id: string;
  purpose: VrfPurpose;
  subject: { type: string; id: string };
  status: VrfStatus;
  cluster: Cluster;
  /** base58 VRF public key */
  publicKey: string;
  /** the committed parameters, as stored (jsonb) */
  params: unknown;
  /** sha256 hex of the canonical JSON of `params` */
  paramsHash: string;
  alphaText: string | null;
  beacon: Beacon | null;
  /** signatures (explorer links) */
  commitTx: string | null;
  commitSlot: number | null;
  /** ISO 8601 */
  revealBy: string;
  proofHex: string | null;
  outputHex: string | null;
  revealTx: string | null;
  result: unknown | null;
}

export type VrfErrorCode =
  | 'bad_input'
  | 'bad_alpha'
  | 'bad_memo'
  | 'bad_proof'
  | 'key_missing'
  | 'key_invalid'
  | 'key_not_separate'
  | 'browser_bundle';

/** Never carries a secret: messages name the problem, not the value. */
export class VrfError extends Error {
  constructor(public readonly code: VrfErrorCode, message: string) {
    super(message);
    this.name = 'VrfError';
  }
}
