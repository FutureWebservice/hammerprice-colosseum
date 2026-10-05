/** A complete revealed request plus an in-memory chain, for the verifier tests. No network, no secrets of ours. */
import { SecretKey } from '@blueshift-gg/solana-ecvrf';
import bs58 from 'bs58';
import type { Cluster } from '@/contracts';
import { buildAlpha } from '../alpha';
import { paramsHashOf, sha256Hex } from '../canonical';
import { lotOrderParams, raffleParams } from '../commitment';
import { fromHex } from '../bytes';
import { lotOrderFromOutput, raffleWinnerFromOutput } from '../derive';
import { buildCommitMemo, buildRevealMemo } from '../memo';
import { vrfProve } from '../prove';
import type { ChainTx, SigInfo, VrfRpc } from '../rpc';
import { ALPHA_PURPOSE_OF, type VrfPurpose, type VrfRequestView } from '../types';

export const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
export const secretKey = () => SecretKey.fromSeed(SEED);
export const b58hash = (label: string): string => bs58.encode(fromHex(sha256Hex(label)));
export const fakeSig = (label: string): string => bs58.encode(Uint8Array.from({ length: 64 }, (_, i) => (label.charCodeAt(i % label.length) + i) & 255));

export const REQUEST_ID = '1a2b3c4d-2222-4333-8444-5555abcdef55';
export const SHOW_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
export const LOT_IDS = Array.from({ length: 6 }, (_, i) => `00000000-0000-4000-8000-00000000000${i + 1}`);
export const REVEAL_BY_UNIX = 1_790_000_120;
export const COMMIT_SLOT = 400_000_000;
export const BEACON_SLOT = COMMIT_SLOT + 33;

export interface World {
  view: VrfRequestView;
  rpc: FakeRpc;
  publicKey: string;
}

export class FakeRpc implements VrfRpc {
  txs = new Map<string, ChainTx>();
  blocks: number[] = [];
  hashes = new Map<number, string>();
  sigs: SigInfo[] = [];
  calls = { getTx: 0, getBlocks: 0, getBlockhash: 0, getSignatures: 0 };
  failAll = false;
  async getTx(s: string) { this.calls.getTx++; if (this.failAll) throw new Error('boom'); return this.txs.get(s) ?? null; }
  async getBlocks(a: number, b: number) { this.calls.getBlocks++; if (this.failAll) throw new Error('boom'); return this.blocks.filter((x) => x >= a && x <= b); }
  async getBlockhash(s: number) { this.calls.getBlockhash++; if (this.failAll) throw new Error('boom'); return this.hashes.get(s) ?? null; }
  async getSignatures(_a: string, before?: string) {
    this.calls.getSignatures++;
    if (this.failAll) throw new Error('boom');
    const i = before ? this.sigs.findIndex((s) => s.signature === before) + 1 : 0;
    return this.sigs.slice(i, i + 1000);
  }
}

export function makeWorld(cluster: Cluster = 'devnet', purpose: VrfPurpose = 'lot_order'): World {
  const sk = secretKey();
  const publicKey = sk.publicKey.toString();
  const params = purpose === 'raffle'
    ? raffleParams(SHOW_ID, [4, 5, 6, 9, 12, 13])
    : lotOrderParams(SHOW_ID, LOT_IDS.map((id, i) => ({ id, n: i + 1 })));
  const ph = paramsHashOf(params);
  const beacon = { slot: BEACON_SLOT, blockhash: b58hash('beacon') };
  const alphaText = buildAlpha({ cluster, purpose: ALPHA_PURPOSE_OF[purpose], subject: REQUEST_ID, paramsHash: ph, beacon });
  const { proofHex, outputHex } = vrfProve(sk, alphaText);
  const out = fromHex(outputHex, 64);
  const result = purpose === 'raffle'
    ? { winnerPaddle: raffleWinnerFromOutput(out, (params as { entrants: number[] }).entrants), entrants: (params as { entrants: number[] }).entrants }
    : { order: lotOrderFromOutput(out, LOT_IDS), applied: true };
  const commitTx = fakeSig('commit');
  const revealTx = fakeSig('reveal');
  const view: VrfRequestView = {
    id: REQUEST_ID, purpose, subject: { type: 'show', id: SHOW_ID }, status: 'revealed', cluster, publicKey,
    params, paramsHash: ph, alphaText, beacon, commitTx, commitSlot: COMMIT_SLOT,
    revealBy: new Date(REVEAL_BY_UNIX * 1000).toISOString(), proofHex, outputHex, revealTx, result,
  };
  const rpc = new FakeRpc();
  const commitMemo = buildCommitMemo(REQUEST_ID, ph, REVEAL_BY_UNIX);
  const revealMemo = buildRevealMemo(REQUEST_ID, beacon, proofHex);
  rpc.txs.set(commitTx, { slot: COMMIT_SLOT, blockTime: REVEAL_BY_UNIX - 100, failed: false, signers: ['SAxxxx', publicKey], memos: [commitMemo] });
  rpc.txs.set(revealTx, { slot: BEACON_SLOT + 4, blockTime: REVEAL_BY_UNIX - 50, failed: false, signers: ['SAxxxx', publicKey], memos: [revealMemo] });
  rpc.blocks = [BEACON_SLOT, BEACON_SLOT + 1, BEACON_SLOT + 2];
  rpc.hashes.set(BEACON_SLOT, beacon.blockhash);
  rpc.sigs = [
    { signature: revealTx, slot: BEACON_SLOT + 4, blockTime: REVEAL_BY_UNIX - 50, failed: false, memos: [revealMemo] },
    { signature: commitTx, slot: COMMIT_SLOT, blockTime: REVEAL_BY_UNIX - 100, failed: false, memos: [commitMemo] },
  ];
  return { view, rpc, publicKey };
}
