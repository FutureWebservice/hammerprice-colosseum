/** The browser side of a credit purchase: what is checked before the wallet is asked, and the whole flow with a fake wallet and a fake server, for both clusters. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { AI_PACK_PRICE_USDC } from '@/contracts';
import { MAINNET_USDC_MINT } from '@/lib/chain/config';
import { buildUnsignedCreditTx } from '@/lib/chain/credit-tx';
import { buildExpectedCredit } from '@/server/credits/service';
import { buyCreditPack, type BuyStep } from '../buy';
import { expectedFromQuote, QuoteRefused } from '../expected';

const ID = 'dddddddd-0000-4000-8000-000000000001';
const sa = Keypair.generate(), buyer = Keypair.generate(), fee = Keypair.generate();
const devMint = Keypair.generate().publicKey.toBase58();

function quote(cluster: 'devnet' | 'mainnet-beta', over: { buyer?: string; amount?: string; mint?: string; memo?: string; feeWallet?: string } = {}) {
  const usdcMint = cluster === 'mainnet-beta' ? MAINNET_USDC_MINT : devMint;
  const e = buildExpectedCredit({ purchaseId: ID, cluster, buyer: over.buyer ?? buyer.publicKey.toBase58(), feePayer: sa.publicKey.toBase58(), feeWallet: over.feeWallet ?? fee.publicKey.toBase58(), usdcMint: over.mint ?? usdcMint, amount: BigInt(over.amount ?? AI_PACK_PRICE_USDC) });
  const bytes = buildUnsignedCreditTx(e, Keypair.generate().publicKey.toBase58());
  return { purchaseId: ID, txBase64: Buffer.from(bytes).toString('base64'), expected: { feePayer: e.feePayer, buyer: e.buyer, feeWallet: e.feeWallet, mint: e.usdcMint, amount: e.amount, memo: over.memo ?? e.memo }, roundExpiresAt: new Date(Date.now() + 60_000).toISOString() };
}

describe.each(['devnet', 'mainnet-beta'] as const)('expectedFromQuote on %s', (cluster) => {
  const wallet = buyer.publicKey.toBase58();
  const pinned = { mint: cluster === 'mainnet-beta' ? MAINNET_USDC_MINT : devMint, feeWallet: fee.publicKey.toBase58() };
  it('accepts an honest quote', () => {
    expect(expectedFromQuote(quote(cluster), { wallet, cluster, pinned })).toMatchObject({ buyer: wallet, amount: AI_PACK_PRICE_USDC, cluster });
  });
  it.each([
    ['a different buyer', { buyer: Keypair.generate().publicKey.toBase58() }],
    ['a different amount', { amount: '5000000' }],
    ['another memo', { memo: 'hp:credits:other' }],
    ['another mint than this build', { mint: Keypair.generate().publicKey.toBase58() }],
    ['another fee wallet than this build', { feeWallet: Keypair.generate().publicKey.toBase58() }],
  ])('refuses %s', (_n, over) => {
    expect(() => expectedFromQuote(quote(cluster, over), { wallet, cluster, pinned })).toThrow(QuoteRefused);
  });
  it('on mainnet only the real USDC mint is accepted, even when the build pins nothing', () => {
    const q = quote(cluster, { mint: devMint });
    if (cluster === 'mainnet-beta') expect(() => expectedFromQuote(q, { wallet, cluster })).toThrow(QuoteRefused);
    else expect(expectedFromQuote(q, { wallet, cluster }).usdcMint).toBe(devMint);
  });
});

describe.each(['devnet', 'mainnet-beta'] as const)('the purchase flow on %s (fake wallet, fake server)', (cluster) => {
  const wallet = buyer.publicKey.toBase58();
  const pinned = { mint: cluster === 'mainnet-beta' ? MAINNET_USDC_MINT : devMint, feeWallet: fee.publicKey.toBase58() };
  let calls: { url: string; body?: unknown }[] = [];
  let routes: Record<string, () => { status: number; json: unknown }> = {};
  beforeEach(() => {
    calls = []; routes = {};
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const r = routes[`${init?.method ?? 'GET'} ${url}`]?.() ?? { status: 500, json: { ok: false, code: 'unknown', reason: 'no route' } };
      return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());
  const sign = async (tx: Transaction) => { tx.partialSign(buyer); return tx; };
  const run = (signTransaction = sign, steps: BuyStep[] = []) => buyCreditPack({ wallet, cluster, signTransaction, onStep: (s) => steps.push(s), pinned, sleep: async () => undefined, waitMs: 5_000 });
  const view = (status: string, balance = 10) => ({ purchaseId: ID, status, balance, ...(status === 'settled' ? { txSignature: '5'.repeat(88), explorerUrl: 'https://explorer.example/tx/x' } : {}) });

  it('quote, check, sign, send, wait: the signed message is posted and the balance comes back', async () => {
    routes['POST /api/ai/credits/quote'] = () => ({ status: 200, json: quote(cluster) });
    routes['POST /api/ai/credits/pay'] = () => ({ status: 200, json: view('submitted', 0) });
    routes[`GET /api/ai/credits/purchases/${ID}`] = () => ({ status: 200, json: view('settled') });
    const steps: BuyStep[] = [];
    const r = await run(sign, steps);
    expect(r).toMatchObject({ ok: true, balance: 10 });
    expect(steps).toEqual(['quote', 'check', 'sign', 'send', 'wait']);
    const posted = calls.find((c) => c.url === '/api/ai/credits/pay')!.body as { purchaseId: string; signedTxBase64: string };
    expect(posted.purchaseId).toBe(ID);
    const t = Transaction.from(Buffer.from(posted.signedTxBase64, 'base64'));
    expect(t.signatures.find((s) => s.publicKey.equals(buyer.publicKey))?.signature).toBeTruthy(); // the buyer signed; SA is added by the server
  });
  it('a wallet that refuses posts nothing and says so', async () => {
    routes['POST /api/ai/credits/quote'] = () => ({ status: 200, json: quote(cluster) });
    const r = await run(async () => { throw new Error('User rejected'); });
    expect(r).toEqual({ ok: false, key: 'credits.rejected' });
    expect(calls.map((c) => c.url)).toEqual(['/api/ai/credits/quote']);
  });
  it('a wallet that changes the message is caught before anything is posted', async () => {
    routes['POST /api/ai/credits/quote'] = () => ({ status: 200, json: quote(cluster) });
    const r = await run(async (tx) => { tx.add(SystemProgram.transfer({ fromPubkey: buyer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 5 })); tx.partialSign(buyer); return tx; });
    expect(r).toEqual({ ok: false, key: 'credits.mismatch' });
    expect(calls.map((c) => c.url)).toEqual(['/api/ai/credits/quote']);
  });
  it('a quote for another buyer, amount or memo never reaches the wallet', async () => {
    let asked = 0;
    for (const over of [{ buyer: Keypair.generate().publicKey.toBase58() }, { amount: '9000000' }, { memo: 'hp:credits:x' }]) {
      routes['POST /api/ai/credits/quote'] = () => ({ status: 200, json: quote(cluster, over) });
      expect(await run(async (tx) => { asked++; return tx; })).toEqual({ ok: false, key: 'credits.mismatch' });
    }
    expect(asked).toBe(0);
  });
  it('a transaction that does not match its own quote never reaches the wallet', async () => {
    const q = quote(cluster);
    const other = quote(cluster, { amount: '2000000' }); // honest-looking fields, but the bytes of a different payment
    routes['POST /api/ai/credits/quote'] = () => ({ status: 200, json: { ...q, txBase64: other.txBase64 } });
    let asked = 0;
    expect(await run(async (tx) => { asked++; return tx; })).toEqual({ ok: false, key: 'credits.mismatch' });
    expect(asked).toBe(0);
  });
  it.each([
    [429, 'rate_limited', 'credits.limitReached'],
    [409, 'insufficient_usdc', 'credits.insufficient'],
    [503, 'rpc_unavailable', 'credits.unavailable'],
    [503, 'mainnet_config_incomplete', 'credits.unavailable'],
  ])('a %s %s on the quote becomes %s', async (status, code, key) => {
    routes['POST /api/ai/credits/quote'] = () => ({ status, json: { ok: false, code, reason: 'x' } });
    expect(await run()).toEqual({ ok: false, key });
  });
  it('an expired round (409 round_expired on pay) asks to start again; a failed purchase says nothing was credited', async () => {
    routes['POST /api/ai/credits/quote'] = () => ({ status: 200, json: quote(cluster) });
    routes['POST /api/ai/credits/pay'] = () => ({ status: 409, json: { ok: false, code: 'round_expired', reason: 'x' } });
    expect(await run()).toEqual({ ok: false, key: 'credits.expired' });
    routes['POST /api/ai/credits/pay'] = () => ({ status: 200, json: view('failed', 0) });
    expect(await run()).toEqual({ ok: false, key: 'credits.failed' });
  });
  it('a server answer of the wrong shape is a plain failure, never a crash', async () => {
    routes['POST /api/ai/credits/quote'] = () => ({ status: 200, json: { hello: 'world' } });
    expect(await run()).toEqual({ ok: false, key: 'credits.failed' });
  });
});
