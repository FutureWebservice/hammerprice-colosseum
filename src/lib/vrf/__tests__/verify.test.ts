import { SecretKey } from '@blueshift-gg/solana-ecvrf';
import { describe, expect, it } from 'vitest';
import type { Cluster } from '@/contracts';
import { fromHex, toHex } from '../bytes';
import { buildCommitMemo } from '../memo';
import { hasFailure, isLocallyProven, verifyChain, verifyCrypto, verifyRequest, type Check, type CheckId } from '../verify';
import { BEACON_SLOT, COMMIT_SLOT, REQUEST_ID, REVEAL_BY_UNIX, b58hash, fakeSig, makeWorld, type World } from './testkit';

const status = (cs: Check[], id: CheckId) => cs.find((c) => c.id === id)!.status;
const ids: CheckId[] = ['params_hash', 'alpha', 'proof', 'output', 'result', 'commit_memo', 'beacon', 'reveal_memo', 'single_commit'];
const clone = (w: World): World => ({ ...w, view: structuredClone(w.view) });

describe.each([['devnet'], ['mainnet-beta']] as [Cluster][])('verifier on %s', (cluster) => {
  describe.each([['lot_order'], ['raffle']] as ['lot_order' | 'raffle'][])('%s', (purpose) => {
    it('all nine rules pass, in rule order', async () => {
      const w = makeWorld(cluster, purpose);
      const cs = await verifyRequest(w.view, { rpc: w.rpc });
      expect(cs.map((c) => c.id)).toEqual(ids);
      expect(cs.map((c) => c.status)).toEqual(Array(9).fill('pass'));
      expect(isLocallyProven(cs)).toBe(true);
      expect(hasFailure(cs)).toBe(false);
    });
    it('the crypto rules need no RPC and the chain rules are skipped without one', async () => {
      const w = makeWorld(cluster, purpose);
      expect(verifyCrypto(w.view).map((c) => c.status)).toEqual(Array(5).fill('pass'));
      const cs = await verifyRequest(w.view);
      expect(cs.slice(5).map((c) => c.status)).toEqual(Array(4).fill('skipped'));
      expect(isLocallyProven(cs)).toBe(true);
      expect(w.rpc.calls.getTx).toBe(0);
    });
  });

  it('an alpha built for the other cluster does not verify against this request', () => {
    const w = makeWorld(cluster);
    const other = cluster === 'devnet' ? 'mainnet-beta' : 'devnet';
    expect(status(verifyCrypto({ ...w.view, cluster: other }), 'alpha')).toBe('fail');
  });
});

describe('cryptographic tampering', () => {
  const flip = (hex: string, i: number) => { const b = fromHex(hex); b[i]! ^= 1; return toHex(b); };
  const cases: [string, (v: World['view']) => void, CheckId][] = [
    ['params changed', (v) => { (v.params as { lots: { n: number }[] }).lots[0]!.n = 99; }, 'params_hash'],
    ['params hash changed', (v) => { v.paramsHash = '0'.repeat(64); }, 'params_hash'],
    ['alpha text changed', (v) => { v.alphaText = v.alphaText!.replace('cluster:', 'cluster: '); }, 'alpha'],
    ['beacon slot changed', (v) => { v.beacon!.slot += 1; }, 'alpha'],
    ['beacon blockhash changed', (v) => { v.beacon!.blockhash = b58hash('other'); }, 'alpha'],
    ['request id changed', (v) => { v.id = '9a9a9a9a-2222-4333-8444-5555abcdef55'; }, 'alpha'],
    ['proof flipped', (v) => { v.proofHex = flip(v.proofHex!, 40); }, 'proof'],
    ['proof not hex', (v) => { v.proofHex = 'zz'; }, 'proof'],
    ['output changed', (v) => { v.outputHex = flip(v.outputHex!, 0); }, 'output'],
    ['result order swapped', (v) => { const o = (v.result as { order: string[] }).order; [o[0], o[1]] = [o[1]!, o[0]!]; }, 'result'],
    ['result missing', (v) => { v.result = null; }, 'result'],
  ];
  it.each(cases)('%s is caught by %s', (_n, mutate, expected) => {
    const w = clone(makeWorld());
    mutate(w.view);
    const cs = verifyCrypto(w.view);
    expect(status(cs, expected)).toBe('fail');
    expect(isLocallyProven(cs)).toBe(false);
  });
  it('another public key fails the proof', () => {
    const w = clone(makeWorld());
    w.view.publicKey = SecretKey.fromSeed(new Uint8Array(32).fill(7)).publicKey.toString();
    expect(status(verifyCrypto(w.view), 'proof')).toBe('fail');
  });
  it('a raffle winner that is not the derived one fails', () => {
    const w = clone(makeWorld('devnet', 'raffle'));
    const r = w.view.result as { winnerPaddle: number; entrants: number[] };
    r.winnerPaddle = r.entrants.find((p) => p !== r.winnerPaddle)!;
    expect(status(verifyCrypto(w.view), 'result')).toBe('fail');
  });
  it('params not in canonical order fail the result rule', () => {
    const w = clone(makeWorld());
    (w.view.params as { lots: unknown[] }).lots.reverse();
    const cs = verifyCrypto(w.view);
    expect(status(cs, 'params_hash')).toBe('fail');
    expect(status(cs, 'result')).toBe('fail');
  });
});

describe('request states', () => {
  it('pending and committed requests skip what does not exist yet and are never "proven"', () => {
    const w = clone(makeWorld());
    Object.assign(w.view, { status: 'committed', alphaText: null, beacon: null, proofHex: null, outputHex: null, revealTx: null, result: null });
    const cs = verifyCrypto(w.view);
    expect(cs.map((c) => c.status)).toEqual(['pass', 'skipped', 'skipped', 'skipped', 'skipped']);
    expect(isLocallyProven(cs)).toBe(false);
    expect(hasFailure(cs)).toBe(false);
  });
  it('a revealed request with a missing proof package fails', () => {
    const w = clone(makeWorld());
    w.view.proofHex = null;
    expect(hasFailure(verifyCrypto(w.view))).toBe(true);
  });
  it('a defaulted request is not proven and not a failure', async () => {
    const w = clone(makeWorld());
    Object.assign(w.view, { status: 'defaulted', alphaText: null, beacon: null, proofHex: null, outputHex: null, revealTx: null, result: null });
    const cs = await verifyRequest(w.view, { rpc: w.rpc });
    expect(isLocallyProven(cs)).toBe(false);
    expect(hasFailure(cs)).toBe(false);
    expect(status(cs, 'commit_memo')).toBe('pass');
    expect(status(cs, 'single_commit')).toBe('pass');
    expect(status(cs, 'beacon')).toBe('skipped');
  });
});

describe('chain rules', () => {
  const run = (w: World) => verifyChain(w.view, w.rpc);

  it('commit memo: wrong text, missing signer, wrong slot, failed tx, missing tx', async () => {
    let w = makeWorld();
    w.rpc.txs.get(w.view.commitTx!)!.memos = [buildCommitMemo(REQUEST_ID, '0'.repeat(64), REVEAL_BY_UNIX)];
    expect(status(await run(w), 'commit_memo')).toBe('fail');
    w = makeWorld(); w.rpc.txs.get(w.view.commitTx!)!.signers = ['SAxxxx'];
    expect(status(await run(w), 'commit_memo')).toBe('fail');
    w = makeWorld(); w.rpc.txs.get(w.view.commitTx!)!.slot += 1;
    expect(status(await run(w), 'commit_memo')).toBe('fail');
    w = makeWorld(); w.rpc.txs.get(w.view.commitTx!)!.failed = true;
    expect(status(await run(w), 'commit_memo')).toBe('fail');
    w = makeWorld(); w.rpc.txs.delete(w.view.commitTx!);
    expect(status(await run(w), 'commit_memo')).toBe('unverifiable');
  });
  it('commit memo: a different deadline in the memo than in the view fails', async () => {
    const w = clone(makeWorld());
    w.view.revealBy = new Date((REVEAL_BY_UNIX + 60) * 1000).toISOString();
    expect(status(await run(w), 'commit_memo')).toBe('fail');
  });
  it('beacon: not the first confirmed slot, wrong blockhash, no block', async () => {
    let w = makeWorld(); w.rpc.blocks = [BEACON_SLOT - 1, BEACON_SLOT];
    expect(status(await run(w), 'beacon')).toBe('fail');
    w = makeWorld(); w.rpc.hashes.set(BEACON_SLOT, b58hash('forged'));
    expect(status(await run(w), 'beacon')).toBe('fail');
    w = makeWorld(); w.rpc.hashes.delete(BEACON_SLOT);
    expect(status(await run(w), 'beacon')).toBe('unverifiable');
    w = makeWorld(); w.rpc.blocks = [];
    expect(status(await run(w), 'beacon')).toBe('unverifiable');
  });
  it('beacon window starts 32 slots after the commit', async () => {
    const w = makeWorld();
    w.rpc.blocks = [COMMIT_SLOT + 31, BEACON_SLOT - 1 + 0, BEACON_SLOT]; // 31 is outside the window, 32 is inside
    expect(status(await run(w), 'beacon')).toBe('fail'); // first in window is commit+32, not the beacon
  });
  it('reveal memo: wrong proof, late block time, before the beacon, wrong signer', async () => {
    let w = makeWorld(); w.rpc.txs.get(w.view.revealTx!)!.memos = ['hp:vrf:r1:x'];
    expect(status(await run(w), 'reveal_memo')).toBe('fail');
    w = makeWorld(); w.rpc.txs.get(w.view.revealTx!)!.blockTime = REVEAL_BY_UNIX + 1;
    expect(status(await run(w), 'reveal_memo')).toBe('fail');
    w = makeWorld(); w.rpc.txs.get(w.view.revealTx!)!.blockTime = REVEAL_BY_UNIX;
    expect(status(await run(w), 'reveal_memo')).toBe('pass'); // on the deadline second is still in time
    w = makeWorld(); w.rpc.txs.get(w.view.revealTx!)!.slot = BEACON_SLOT;
    expect(status(await run(w), 'reveal_memo')).toBe('fail');
    w = makeWorld(); w.rpc.txs.get(w.view.revealTx!)!.signers = [];
    expect(status(await run(w), 'reveal_memo')).toBe('fail');
    w = makeWorld(); w.rpc.txs.get(w.view.revealTx!)!.blockTime = null;
    expect(status(await run(w), 'reveal_memo')).toBe('unverifiable');
  });
  it('single commit: a second commit memo (hidden retry) fails; failed txs do not count', async () => {
    let w = makeWorld();
    w.rpc.sigs.push({ signature: fakeSig('dup'), slot: COMMIT_SLOT - 5, blockTime: 1, failed: false, memos: [w.rpc.txs.get(w.view.commitTx!)!.memos[0]!] });
    const cs = await run(w);
    expect(status(cs, 'single_commit')).toBe('fail');
    expect(cs.find((c) => c.id === 'single_commit')!.detail).toMatch(/2 commit/);
    w = makeWorld();
    w.rpc.sigs.push({ signature: fakeSig('dup'), slot: COMMIT_SLOT - 5, blockTime: 1, failed: true, memos: [w.rpc.txs.get(w.view.commitTx!)!.memos[0]!] });
    expect(status(await run(w), 'single_commit')).toBe('pass');
    w = makeWorld(); w.rpc.sigs = w.rpc.sigs.filter((s) => s.signature !== w.view.commitTx);
    expect(status(await run(w), 'single_commit')).toBe('fail'); // zero commits
  });
  it('single commit pages through more than 1000 signatures', async () => {
    const w = makeWorld();
    const filler = Array.from({ length: 1500 }, (_, i) => ({ signature: fakeSig(`f${i}`) + i, slot: 1, blockTime: 1, failed: false, memos: [] as string[] }));
    w.rpc.sigs = [...filler.slice(0, 700), ...w.rpc.sigs, ...filler.slice(700)];
    expect(status(await run(w), 'single_commit')).toBe('pass');
    expect(w.rpc.calls.getSignatures).toBeGreaterThan(1);
  });
  it('an RPC that fails gives "unverifiable" on every chain rule, never a pass and never a crash', async () => {
    const w = makeWorld(); w.rpc.failAll = true;
    const cs = await run(w);
    expect(cs.map((c) => c.status)).toEqual(Array(4).fill('unverifiable'));
    expect(cs[0]!.detail).toMatch(/RPC/);
  });
});
