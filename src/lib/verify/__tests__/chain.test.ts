import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import { makeRpc } from '@/lib/chain/rpc';
import { CIRCLE_DEVNET_USDC_MINT, DEFAULT_RPC, MAINNET_USDC_MINT } from '@/lib/chain/config';
import { explorerTxUrl } from '@/lib/chain/explorer';
import { bidLogHash } from '@/lib/client/settle';
import { fetchVerifyData, settlementTarget, verifyAll, verifyOnChain, VerifyData } from '@/components/room/verifyData';
import {
  chainTarget, checkChain, formatUnits, memoOf, parseSettleMemo, readFacts, MEMO_PROGRAM, type ChainState, type ParsedTx,
} from '../chain';
import bidsFixture from './fixtures/devnet-lot-bids.json';
import txFixture from './fixtures/devnet-settlement-tx.json';

// The real devnet settlement (production, 2026-10-02): lot c82e6cef, 4 signed bids, settlement d22dba70, finalized transaction jNzE8G...
const SIG = 'jNzE8GsVPwVKhyTXmEyqymPFmzj4oR72r2P3CoAWP2WTKJo4Axq9Y9hECQjCePHZRddSSs8Bphfehn5e89j4eGL';
const SETTLEMENT_ID = 'd22dba70-68cc-4861-95a1-b382323f3c3f';
const HASH = '04eed183147f346f9dc3e3faee1d6b29dcdff2f090243a1c9a921e75044b53ee';
const DEVNET_MINT = '2J9jiJYT6NGbwrf2kUthFXwo16B7W1GzpxxF9Kgf8bix';
const BUYER = '9gyqQs6Hq2gzsYkcjDBMmtRMm7AQ42sdfeGUc8tDnLrx';
const SELLER = 'DC5Lj8fBXhvdgbcmCMfk8M3cMfSovWV4C3TZt8foWa6K';
const SA = '9t1vtYL2xZW1Z67aWp7fcb8WmUz1w46fbYutTEzxQrDQ';

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const realTx = (): ParsedTx => clone(txFixture) as unknown as ParsedTx;
const memoIx = (text: string, programId = MEMO_PROGRAM) => ({ programId, program: 'spl-memo', parsed: text, stackHeight: 1 });
/** The real transaction with its memo instruction(s) replaced. */
const withMemos = (...ixs: unknown[]): ParsedTx => {
  const tx = realTx();
  const list = tx.transaction.message.instructions;
  tx.transaction.message.instructions = [...list.filter((i) => i.programId !== MEMO_PROGRAM), ...(ixs as typeof list)];
  return tx;
};

type Answer = unknown | (() => never);
/** A fake fetch that answers each JSON-RPC method from `byMethod` and records the calls. */
function fakeRpc(byMethod: Record<string, Answer>) {
  const calls: { url: string; method: string; params: unknown[] }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { method: string; params: unknown[] };
    calls.push({ url, method: body.method, params: body.params });
    const a = byMethod[body.method];
    if (typeof a === 'function') (a as () => never)();
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: a ?? null }) } as Response;
  }) as unknown as typeof fetch;
  return { f, calls };
}
const status = (confirmationStatus: string) => ({ value: [{ err: null, confirmationStatus }] });
const call = (f: typeof fetch, cluster: 'devnet' | 'mainnet-beta' = 'devnet') => makeRpc(cluster, { fetch: f, urls: [DEFAULT_RPC[cluster]] });
const kindOf = (s: ChainState) => s.kind;

describe('parseSettleMemo', () => {
  it('reads hp:settle:<uuid>:<64 hex>', () => {
    expect(parseSettleMemo(`hp:settle:${SETTLEMENT_ID}:${HASH}`)).toEqual({ settlementId: SETTLEMENT_ID, hash: HASH });
  });
  it.each([
    ['upper-case hash', `hp:settle:${SETTLEMENT_ID}:${HASH.toUpperCase()}`],
    ['short hash', `hp:settle:${SETTLEMENT_ID}:${HASH.slice(1)}`],
    ['long hash', `hp:settle:${SETTLEMENT_ID}:${HASH}0`],
    ['no settlement id', `hp:settle:${HASH}`],
    ['extra segment', `hp:settle:${SETTLEMENT_ID}:${HASH}:x`],
    ['another prefix', `hp:other:${SETTLEMENT_ID}:${HASH}`],
    ['leading text', ` hp:settle:${SETTLEMENT_ID}:${HASH}`],
    ['empty', ''],
  ])('refuses %s', (_n, text) => expect(parseSettleMemo(text)).toBeNull());
});

describe('memoOf', () => {
  it('finds the one memo of the real transaction', () => {
    expect(memoOf(realTx())).toEqual({ kind: 'ok', text: `hp:settle:${SETTLEMENT_ID}:${HASH}`, settlementId: SETTLEMENT_ID, hash: HASH });
  });
  it('ignores a lookalike from another program', () => {
    expect(memoOf(withMemos(memoIx(`hp:settle:${SETTLEMENT_ID}:${HASH}`, 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo')))).toEqual({ kind: 'none' });
  });
  it('has none when the memo instruction is missing', () => expect(memoOf(withMemos())).toEqual({ kind: 'none' }));
  it('refuses two hp:settle memos', () => {
    const m = memoIx(`hp:settle:${SETTLEMENT_ID}:${HASH}`);
    expect(memoOf(withMemos(m, m))).toEqual({ kind: 'several' });
  });
  it('lets an unrelated memo sit next to ours', () => {
    expect(memoOf(withMemos(memoIx('hello'), memoIx(`hp:settle:${SETTLEMENT_ID}:${HASH}`))).kind).toBe('ok');
  });
  it('flags a memo that has the prefix but not the format', () => {
    expect(memoOf(withMemos(memoIx('hp:settle:not-a-uuid:abc')))).toEqual({ kind: 'malformed', text: 'hp:settle:not-a-uuid:abc' });
  });
  it('decodes the raw data when the node did not parse the memo', () => {
    const text = `hp:settle:${SETTLEMENT_ID}:${HASH}`;
    const data = bs58.encode(Buffer.from(text));
    expect(memoOf(withMemos({ programId: MEMO_PROGRAM, data, accounts: [] })).kind).toBe('ok');
  });
  it('does not count a memo inside a CPI (only top-level instructions)', () => {
    const tx = withMemos();
    (tx.meta as Record<string, unknown>).innerInstructions = [{ index: 0, instructions: [memoIx(`hp:settle:${SETTLEMENT_ID}:${HASH}`)] }];
    expect(memoOf(tx)).toEqual({ kind: 'none' });
  });
});

describe('readFacts on the real devnet settlement', () => {
  const f = readFacts(realTx(), 'devnet', DEVNET_MINT);
  it('reads signature, slot and block time', () => {
    expect(f.signature).toBe(SIG);
    expect(f.slot).toBe(506651369);
    expect(f.blockTime).toBe(1790947588);
    expect(f.commitment).toBe('finalized');
  });
  it('names the three signers by what they did', () => {
    expect(f.signers).toEqual([{ address: SA, role: 'fee_payer' }, { address: BUYER, role: 'buyer' }, { address: SELLER, role: 'seller' }]);
  });
  it('reads both USDC legs with the wallet that received them', () => {
    expect(f.usdc.map((m) => [m.from, formatUnits(m.amount, m.decimals), m.isUsdc])).toEqual([[BUYER, '76.05', true], [BUYER, '1.95', true]]);
    expect(f.usdc[0]!.to).toBe(SELLER);
    expect(f.usdc[1]!.to).toBe('6YPWzaeTwUGVCxJse8Y2oxVHAtqmF6V2VDRsDfUKKrNf');
  });
  it('reads the card transfer: seller to buyer', () => {
    expect(f.card).toEqual({ asset: '9qJqZ4StrJiQBufoe4wTpgbKyNS65EsDQ2mESrKC5cPW', from: SELLER, to: BUYER });
  });
  it('does not call a token USDC when it is not the cluster mint', () => {
    expect(readFacts(realTx(), 'devnet', CIRCLE_DEVNET_USDC_MINT).usdc.every((m) => !m.isUsdc)).toBe(true);
    expect(readFacts(realTx(), 'devnet').usdc.every((m) => !m.isUsdc)).toBe(true);
  });
});

describe('formatUnits', () => {
  it.each([['76050000', 6, '76.05'], ['1950000', 6, '1.95'], ['933000000', 6, '933'], ['500000', 6, '0.50'], ['1', 6, '0.000001'], ['0', 6, '0'], ['42', 0, '42']] as const)('%s at %i decimals is %s', (a, d, out) => {
    expect(formatUnits(a, d)).toBe(out);
  });
});

describe('chainTarget follows the config, never a literal cluster', () => {
  it('devnet deployment, devnet settlement: the configured public RPC and USDC mint', () => {
    expect(chainTarget('devnet', { cluster: 'devnet', rpcPublic: 'https://rpc.example/devnet', usdcMint: DEVNET_MINT })).toEqual({ cluster: 'devnet', rpcUrl: 'https://rpc.example/devnet', usdcMint: DEVNET_MINT });
  });
  it('devnet without a configured mint falls back to the Circle devnet mint, like the server', () => {
    expect(chainTarget('devnet', { cluster: 'devnet' })).toEqual({ cluster: 'devnet', rpcUrl: DEFAULT_RPC.devnet, usdcMint: CIRCLE_DEVNET_USDC_MINT });
  });
  it('mainnet deployment, mainnet settlement: configured RPC, real USDC mint', () => {
    expect(chainTarget('mainnet-beta', { cluster: 'mainnet-beta', rpcPublic: 'https://rpc.example/main', usdcMint: MAINNET_USDC_MINT })).toEqual({ cluster: 'mainnet-beta', rpcUrl: 'https://rpc.example/main', usdcMint: MAINNET_USDC_MINT });
    expect(MAINNET_USDC_MINT).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  });
  it('a test mint configured on a mainnet deployment never becomes the mainnet USDC', () => {
    expect(chainTarget('mainnet-beta', { cluster: 'mainnet-beta', usdcMint: DEVNET_MINT }).usdcMint).toBe(MAINNET_USDC_MINT);
  });
  it('a settlement of the other cluster gets that cluster\'s public RPC, not this deployment\'s endpoint or mint', () => {
    expect(chainTarget('mainnet-beta', { cluster: 'devnet', rpcPublic: 'https://rpc.example/devnet', usdcMint: DEVNET_MINT })).toEqual({ cluster: 'mainnet-beta', rpcUrl: DEFAULT_RPC['mainnet-beta'], usdcMint: MAINNET_USDC_MINT });
    expect(chainTarget('devnet', { cluster: 'mainnet-beta', rpcPublic: 'https://rpc.example/main' })).toMatchObject({ cluster: 'devnet', rpcUrl: DEFAULT_RPC.devnet });
  });
  it('an unknown settlement cluster takes the deployment\'s cluster', () => {
    expect(chainTarget(null, { cluster: 'mainnet-beta' }).cluster).toBe('mainnet-beta');
    expect(chainTarget(null, { cluster: 'devnet' }).cluster).toBe('devnet');
  });
  it('a polluted public RPC value is ignored in favour of the public endpoint', () => {
    expect(chainTarget('devnet', { cluster: 'devnet', rpcPublic: 'https://x.example # no key' }).rpcUrl).toBe(DEFAULT_RPC.devnet);
  });
  it('explorer links follow the cluster', () => {
    expect(explorerTxUrl(SIG, 'devnet')).toBe(`https://explorer.solana.com/tx/${SIG}?cluster=devnet`);
    expect(explorerTxUrl(SIG, 'mainnet-beta')).toBe(`https://explorer.solana.com/tx/${SIG}`);
  });
});

describe('checkChain: the three honest outcomes plus "could not read"', () => {
  const input = (f: typeof fetch, over: Partial<Parameters<typeof checkChain>[0]> = {}) => ({
    call: call(f), cluster: 'devnet' as const, usdcMint: DEVNET_MINT, settlement: { id: SETTLEMENT_ID, txSignature: SIG }, recomputed: HASH, ...over,
  });

  it('asks for the finalized transaction, jsonParsed', async () => {
    const { f, calls } = fakeRpc({ getTransaction: txFixture });
    await checkChain(input(f));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: DEFAULT_RPC.devnet, method: 'getTransaction' });
    expect(calls[0]!.params).toEqual([SIG, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'finalized' }]);
  });

  it('confirmed: memo in the finalized transaction equals the recomputed hash', async () => {
    const { f } = fakeRpc({ getTransaction: txFixture });
    const s = await checkChain(input(f));
    expect(s.kind).toBe('confirmed');
    if (s.kind === 'confirmed') expect(s.facts.memo).toMatchObject({ kind: 'ok', hash: HASH });
  });

  it('confirmed (case of the settlement id does not matter)', async () => {
    const { f } = fakeRpc({ getTransaction: txFixture });
    expect(kindOf(await checkChain(input(f, { settlement: { id: SETTLEMENT_ID.toUpperCase(), txSignature: SIG } })))).toBe('confirmed');
  });

  it('contradicts: the memo carries another hash, both values are available', async () => {
    const { f } = fakeRpc({ getTransaction: txFixture });
    const other = 'f'.repeat(64);
    const s = await checkChain(input(f, { recomputed: other }));
    expect(s).toMatchObject({ kind: 'contradicts', why: 'hash' });
    if (s.kind === 'contradicts') expect(s.facts.memo).toMatchObject({ hash: HASH });
  });

  it('contradicts: the memo belongs to another settlement', async () => {
    const { f } = fakeRpc({ getTransaction: txFixture });
    expect(await checkChain(input(f, { settlement: { id: '11111111-2222-4333-8444-555555555555', txSignature: SIG } }))).toMatchObject({ kind: 'contradicts', why: 'settlement' });
  });

  it.each([
    ['no memo', withMemos()],
    ['two memos', withMemos(memoIx(`hp:settle:${SETTLEMENT_ID}:${HASH}`), memoIx(`hp:settle:${SETTLEMENT_ID}:${HASH}`))],
    ['a lookalike program', withMemos(memoIx(`hp:settle:${SETTLEMENT_ID}:${HASH}`, 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo'))],
    ['a malformed memo', withMemos(memoIx('hp:settle:nope'))],
  ])('contradicts (memo): %s', async (_n, tx) => {
    const { f } = fakeRpc({ getTransaction: tx });
    expect(await checkChain(input(f))).toMatchObject({ kind: 'contradicts', why: 'memo' });
  });

  it('contradicts (failed): a failed transaction settled nothing, whatever its memo says', async () => {
    const tx = realTx();
    (tx.meta as Record<string, unknown>).err = { InstructionError: [4, 'Custom'] };
    const { f } = fakeRpc({ getTransaction: tx });
    expect(await checkChain(input(f))).toMatchObject({ kind: 'contradicts', why: 'failed' });
  });

  it('not found: the settlement has no transaction yet (no RPC call at all)', async () => {
    const { f, calls } = fakeRpc({});
    expect(await checkChain(input(f, { settlement: { id: SETTLEMENT_ID, txSignature: null } }))).toEqual({ kind: 'not_found', why: 'no_signature' });
    expect(calls).toHaveLength(0);
  });

  it('not found: a signature that cannot be one is not sent to the node', async () => {
    const { f, calls } = fakeRpc({});
    expect(await checkChain(input(f, { settlement: { id: SETTLEMENT_ID, txSignature: 'not a signature' } }))).toEqual({ kind: 'not_found', why: 'unknown' });
    expect(calls).toHaveLength(0);
  });

  it('not found: the node knows no finalized transaction with this signature', async () => {
    const { f, calls } = fakeRpc({ getTransaction: null, getSignatureStatuses: { value: [null] } });
    expect(await checkChain(input(f))).toEqual({ kind: 'not_found', why: 'unknown' });
    expect(calls.map((c) => c.method)).toEqual(['getTransaction', 'getSignatureStatuses']);
  });

  it.each(['processed', 'confirmed'])('not final yet: the node has the transaction at "%s" only', async (level) => {
    const { f } = fakeRpc({ getTransaction: null, getSignatureStatuses: status(level) });
    expect(await checkChain(input(f))).toEqual({ kind: 'not_found', why: 'not_finalized' });
  });

  it('unreachable: the network cannot be reached (says nothing about the bids)', async () => {
    const { f } = fakeRpc({ getTransaction: () => { throw new TypeError('fetch failed'); } });
    expect(await checkChain(input(f))).toEqual({ kind: 'unreachable' });
  });

  it('unreachable: an answer that is not a transaction we can read is no verdict', async () => {
    const { f } = fakeRpc({ getTransaction: { slot: 'x' } });
    expect(await checkChain(input(f))).toEqual({ kind: 'unreachable' });
  });

  it('unreachable: the node answers with a transaction of another signature', async () => {
    const tx = realTx();
    tx.transaction.signatures = ['5'.repeat(88)];
    const { f } = fakeRpc({ getTransaction: tx });
    expect(await checkChain(input(f))).toEqual({ kind: 'unreachable' });
  });
});

describe('checkChain with the mainnet configuration (mocked RPC, mainnet USDC mint)', () => {
  // The same transaction as if it lived on mainnet: its USDC is the real mainnet mint.
  const mainnetTx = JSON.parse(JSON.stringify(txFixture).split(DEVNET_MINT).join(MAINNET_USDC_MINT)) as ParsedTx;
  const deployment = { cluster: 'mainnet-beta' as const };

  it('reads from the mainnet RPC, recognises the mainnet USDC and links the mainnet explorer', async () => {
    const { f, calls } = fakeRpc({ getTransaction: mainnetTx });
    const target = chainTarget('mainnet-beta', deployment);
    const s = await checkChain({ call: makeRpc(target.cluster, { fetch: f, urls: [target.rpcUrl] }), cluster: target.cluster, usdcMint: target.usdcMint, settlement: { id: SETTLEMENT_ID, txSignature: SIG }, recomputed: HASH });
    expect(calls[0]!.url).toBe(DEFAULT_RPC['mainnet-beta']);
    expect(s.kind).toBe('confirmed');
    if (s.kind === 'confirmed') {
      expect(s.facts.cluster).toBe('mainnet-beta');
      expect(s.facts.usdc.every((m) => m.mint === MAINNET_USDC_MINT && m.isUsdc)).toBe(true);
      expect(explorerTxUrl(s.facts.signature, s.facts.cluster)).not.toContain('cluster=');
    }
  });

  it('the same transaction judged with the devnet mint does not pass for USDC', async () => {
    const { f } = fakeRpc({ getTransaction: mainnetTx });
    const s = await checkChain({ call: call(f, 'mainnet-beta'), cluster: 'mainnet-beta', usdcMint: DEVNET_MINT, settlement: { id: SETTLEMENT_ID, txSignature: SIG }, recomputed: HASH });
    if (s.kind !== 'confirmed') throw new Error('expected confirmed');
    expect(s.facts.usdc.every((m) => !m.isUsdc)).toBe(true);
  });

  it('manipulation on mainnet: a different recomputed hash contradicts', async () => {
    const { f } = fakeRpc({ getTransaction: mainnetTx });
    expect(await checkChain({ call: call(f, 'mainnet-beta'), cluster: 'mainnet-beta', settlement: { id: SETTLEMENT_ID, txSignature: SIG }, recomputed: '0'.repeat(64) })).toMatchObject({ kind: 'contradicts', why: 'hash' });
  });
});

// ---- the whole page logic: real public bids -> recomputed hash -> chain ----------------------------------

describe('verifyOnChain with the real bids of lot c82e6cef', () => {
  const data = (): VerifyData => VerifyData.parse(clone(bidsFixture));
  const devnet = { cluster: 'devnet' as const, usdcMint: DEVNET_MINT };

  it('the real bids hash to the hash in the real memo (browser maths, Ed25519 signatures all valid)', async () => {
    const d = data();
    expect(await bidLogHash(d.bids)).toBe(HASH);
    const r = await verifyAll(d);
    expect(r.recomputed).toBe(HASH);
    expect(r.match).toBe(true);
    expect([...r.checks.values()]).toEqual(['valid', 'valid', 'valid', 'valid']);
  });

  it('confirmed on devnet, reading from the devnet RPC', async () => {
    const d = data();
    const { f, calls } = fakeRpc({ getTransaction: txFixture });
    const s = await verifyOnChain(d, (await verifyAll(d)).recomputed, devnet, f);
    expect(s?.kind).toBe('confirmed');
    expect(calls[0]!.url).toBe(DEFAULT_RPC.devnet);
    expect(settlementTarget(d, devnet)).toEqual({ cluster: 'devnet', rpcUrl: DEFAULT_RPC.devnet, usdcMint: DEVNET_MINT });
  });

  it('a settlement that says mainnet is read from the mainnet RPC even on a devnet deployment', async () => {
    const d = data();
    d.settlement!.cluster = 'mainnet-beta';
    const { f, calls } = fakeRpc({ getTransaction: txFixture });
    await verifyOnChain(d, (await verifyAll(d)).recomputed, devnet, f);
    expect(calls[0]!.url).toBe(DEFAULT_RPC['mainnet-beta']);
  });

  it('TAMPERED bid log: one bid dropped, so the recomputed hash differs from the memo on the chain', async () => {
    const d = data();
    d.bids = d.bids.slice(0, 3);
    const r = await verifyAll(d);
    expect(r.recomputed).not.toBe(HASH);
    expect(r.match).toBe(false); // the server's own value no longer matches either
    const { f } = fakeRpc({ getTransaction: txFixture });
    const s = await verifyOnChain(d, r.recomputed, devnet, f);
    expect(s).toMatchObject({ kind: 'contradicts', why: 'hash' });
    if (s?.kind === 'contradicts' && s.facts.memo.kind === 'ok') {
      expect(s.facts.memo.hash).toBe(HASH);
      expect(s.facts.memo.hash).not.toBe(r.recomputed);
    }
  });

  it('TAMPERED amount: a changed bid fails its signature check and changes the hash', async () => {
    const d = data();
    d.bids[3]!.message = d.bids[3]!.message.replace(/amount: \d+/, 'amount: 1');
    const r = await verifyAll(d);
    expect(r.checks.get(d.bids[3]!.id)).toBe('bad_signature');
    expect(r.recomputed).not.toBe(HASH);
    const { f } = fakeRpc({ getTransaction: txFixture });
    expect(await verifyOnChain(d, r.recomputed, devnet, f)).toMatchObject({ kind: 'contradicts', why: 'hash' });
  });

  it('TAMPERED server hash only: the chain still confirms the real bids, the server row is the one that differs', async () => {
    const d = data();
    d.settlement!.bidLogHash = 'a'.repeat(64);
    const r = await verifyAll(d);
    expect(r.match).toBe(false);
    const { f } = fakeRpc({ getTransaction: txFixture });
    expect((await verifyOnChain(d, r.recomputed, devnet, f))?.kind).toBe('confirmed');
  });

  it('no settlement: nothing to read, no RPC call', async () => {
    const d = data();
    d.settlement = null;
    const { f, calls } = fakeRpc({});
    expect(await verifyOnChain(d, HASH, devnet, f)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('a settlement without a transaction yet is "not found", not an error', async () => {
    const d = data();
    d.settlement!.txSignature = null;
    const { f } = fakeRpc({});
    expect(await verifyOnChain(d, HASH, devnet, f)).toEqual({ kind: 'not_found', why: 'no_signature' });
  });

  it('an unreachable node is "unreachable", never a pass or a failure of the bids', async () => {
    const d = data();
    const { f } = fakeRpc({ getTransaction: () => { throw new TypeError('offline'); } });
    expect(await verifyOnChain(d, HASH, devnet, f)).toEqual({ kind: 'unreachable' });
  });

  it('fetchVerifyData still refuses a body that is not the contract shape', async () => {
    const bad = (async () => ({ ok: true, json: async () => ({ lot: 1 }) })) as unknown as typeof fetch;
    expect(await fetchVerifyData('x', bad)).toBeNull();
  });
});
