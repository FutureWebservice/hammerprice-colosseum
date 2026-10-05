/**
 * An in-memory chain for the draw tests: real transactions are parsed and their signatures verified (so a missing VRF or SA signature
 * fails like on a node), slots move on when the server polls, and the same data answers the browser verifier's `VrfRpc` so the whole path
 * (server state machine, then the nine verifier rules) is tested against one world. Not a test file.
 */
import { createHash } from 'node:crypto';
import { Keypair, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import type { Cluster } from '@/contracts';
import { ChainError } from '@/lib/chain/errors';
import type { ChainTx, SigInfo, VrfRpc } from '@/lib/vrf';
import type { SigStatus, VrfChain } from '../chain';
import { MEMO_PROGRAM_ID } from '@/lib/chain/ix';

const hash58 = (label: string) => bs58.encode(createHash('sha256').update(label).digest());

export interface Landed { signature: string; slot: number; blockTime: number; signers: string[]; memo: string; blockhash: string; level: SigStatus['level'] }

export class FakeChain implements VrfChain {
  slot = 1_000;
  readonly t0 = Math.floor(Date.now() / 1000);
  landed = new Map<string, Landed>();
  sent: string[] = [];
  expired = new Set<string>();
  skipped = new Set<number>();
  calls = { send: 0, blocks: 0 };
  lamportsOf = 5_000_000_000n;
  /** Slots that pass each time the server asks for the finalized slot (time passing while it polls). */
  slotsPerPoll = 20;
  /** Land sent transactions at once (and finalize them) unless set. */
  land = true;
  /** Level a landed transaction starts at; 'confirmed' keeps it from finalizing until `finalizeAll()`. */
  landLevel: SigStatus['level'] = 'finalized';
  failSend: Error | null = null;
  blockTimeOffset = 0;
  private n = 0;
  constructor(readonly cluster: Cluster = 'devnet') {}

  async latestBlockhash() { return hash58(`recent:${++this.n}`); }
  async isBlockhashValid(bh: string) { return !this.expired.has(bh); }
  async lamports() { return this.lamportsOf; }
  async finalizedSlot() { this.slot += this.slotsPerPoll; return this.slot; }
  async blocks(a: number, b: number) { this.calls.blocks++; const r: number[] = []; for (let s = a; s <= Math.min(b, this.slot); s++) if (!this.skipped.has(s)) r.push(s); return r; }
  async blockhashOf(slot: number) { return slot <= this.slot ? hash58(`block:${slot}`) : null; }
  async blockTime(slot: number) { return this.t0 + Math.floor((slot - 1_000) * 0.4) + this.blockTimeOffset; }

  async send(base64: string): Promise<string> {
    this.calls.send++;
    if (this.failSend) throw this.failSend;
    const tx = Transaction.from(Buffer.from(base64, 'base64'));
    if (!tx.verifySignatures()) throw new ChainError('simulation_failed', 'the network rejected the transaction: bad signature');
    const ix = tx.instructions[0]!;
    if (tx.instructions.length !== 1 || !ix.programId.equals(MEMO_PROGRAM_ID)) throw new ChainError('simulation_failed', 'not a memo transaction');
    const signature = bs58.encode(tx.signatures[0]!.signature!);
    this.sent.push(signature);
    if (this.landed.has(signature) || !this.land) return signature;
    const signers = tx.signatures.map((s) => s.publicKey.toBase58());
    this.slot += 1;
    this.landed.set(signature, { signature, slot: this.slot, blockTime: this.t0 + Math.floor((this.slot - 1_000) * 0.4) + this.blockTimeOffset, signers, memo: ix.data.toString('utf8'), blockhash: tx.recentBlockhash!, level: this.landLevel });
    return signature;
  }

  finalizeAll() { for (const l of this.landed.values()) l.level = 'finalized'; }

  async status(signature: string): Promise<SigStatus | null> {
    const l = this.landed.get(signature);
    return l ? { slot: l.slot, err: null, level: l.level } : null;
  }

  /** The browser verifier's view of this chain. */
  rpc(): VrfRpc {
    const all = () => [...this.landed.values()].sort((a, b) => b.slot - a.slot);
    return {
      getTx: async (s): Promise<ChainTx | null> => { const l = this.landed.get(s); return l ? { slot: l.slot, blockTime: l.blockTime, failed: false, signers: l.signers, memos: [l.memo] } : null; },
      getBlocks: (a, b) => this.blocks(a, b),
      getBlockhash: async (s) => this.blockhashOf(s),
      getSignatures: async (address): Promise<SigInfo[]> => all().filter((l) => l.signers.includes(address)).map((l) => ({ signature: l.signature, slot: l.slot, blockTime: l.blockTime, failed: false, memos: [l.memo] })),
    };
  }
}

export const newKey = () => Keypair.generate();
