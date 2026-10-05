/**
 * The credit purchase service over a REAL Postgres 18 and LiteSVM (real token programs), for BOTH cluster configs: the devnet test mint and the
 * real mainnet USDC address created inside the SVM. Money moves only in the SVM; mainnet is never contacted.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { ApiError, AiCreditsQuoteResponse, AiCreditsResponse, AiPurchaseView } from '@/contracts';
import { startTestPg, type TestPg } from '@/db/__tests__/pg-harness';
import { MAINNET_USDC_MINT, usdcMintFor } from '@/lib/chain/config';
import { ConfigError } from '@/lib/chain/errors';
import { createCreditWorld, walletSigns, type CreditWorld } from './credit-world';

let t: TestPg | undefined, skipReason: string | undefined;
let db: typeof import('@/db').db, schema: typeof import('@/db').schema;
let createCreditService: typeof import('../service').createCreditService;
let balanceOf: typeof import('../ledger').balanceOf, book: typeof import('../ledger').book;

beforeAll(async () => {
  const r = await startTestPg({ poolMax: 20 });
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  t = r.pg;
  vi.stubEnv('DATABASE_URL', t.url);
  ({ db, schema } = await import('@/db'));
  ({ createCreditService } = await import('../service'));
  ({ balanceOf, book } = await import('../ledger'));
}, 120_000);
afterAll(async () => {
  await (globalThis as { __pool?: { end(): Promise<void> } }).__pool?.end().catch(() => {});
  vi.unstubAllEnvs();
  await t?.pool.end().catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  await t?.stop();
});
const it_ = (name: string, fn: () => Promise<void> | void, timeout = 30_000) => it(name, async (c) => { if (!t) return c.skip(skipReason); await fn(); }, timeout);

async function newProfile(kp: Keypair) {
  const { upsertProfile } = await import('@/lib/auth/store');
  return upsertProfile(kp.publicKey.toBase58());
}

describe.each([
  ['devnet (test mint)', { cluster: 'devnet' as const, mint: undefined }],
  ['mainnet-beta (the real USDC address, inside LiteSVM)', { cluster: 'mainnet-beta' as const, mint: new PublicKey(MAINNET_USDC_MINT) }],
])('credit purchases on %s', (_name, cfg) => {
  let w: CreditWorld;
  let now = new Date('2030-05-05T10:00:00Z');
  let spendCalls = 0, spendRefuse = false;
  let svc: ReturnType<typeof import('../service').createCreditService>;
  const make = (o: { packsPerDay?: number } = {}) => createCreditService({
    db, chainFor: () => w.port, sa: w.sa, usdcMint: () => w.usdc.toBase58(), feeWallet: w.feeWallet.publicKey.toBase58(), cluster: cfg.cluster, packsPerDay: o.packsPerDay ?? 3,
    now: () => now, sleep: async () => undefined, pollMs: 0, assertCluster: () => undefined, configured: () => true,
    spendGuard: async () => { spendCalls++; if (spendRefuse) throw new ApiError('rate_limited', 'sponsor budget spent'); },
  });
  beforeAll(() => { if (t) { w = createCreditWorld({ mint: cfg.mint, cluster: cfg.cluster }); svc = make(); } });
  beforeEach(() => { now = new Date('2030-05-05T10:00:00Z'); spendCalls = 0; spendRefuse = false; if (w) { w.port.height = 1000; w.port.sent.length = 0; w.port.tamper = undefined; w.port.dieAfterLanding = false; } });

  /** A funded buyer with a signed-in profile. */
  async function buyer(usdc = 5_000_000n) {
    const kp = Keypair.generate();
    w.watch(kp.publicKey);
    if (usdc > 0n) w.fund(kp.publicKey, usdc);
    return { kp, profile: await newProfile(kp) };
  }
  async function quoteAndSign(b: Awaited<ReturnType<typeof buyer>>) {
    const q = AiCreditsQuoteResponse.parse(await svc.quote(b.profile));
    const bytes = new Uint8Array(Buffer.from(q.txBase64, 'base64'));
    return { q, signed: Buffer.from(walletSigns(bytes, b.kp)).toString('base64') };
  }

  it_('overview: no balance, the pack of 10 for 1 USDC, packs left, the cluster', async () => {
    const b = await buyer();
    expect(AiCreditsResponse.parse(await svc.overview(b.profile.id))).toEqual({ balance: 0, pack: { credits: 10, priceUsdc: '1000000' }, packsLeftToday: 3, cluster: cfg.cluster, configured: true, free: false });
  });

  it_('overview says free only when AI_FREE is exactly true', async () => {
    const b = await buyer();
    vi.stubEnv('AI_FREE', 'true');
    expect((await svc.overview(b.profile.id)).free).toBe(true);
    vi.stubEnv('AI_FREE', 'TRUE');
    expect((await svc.overview(b.profile.id)).free).toBe(false);
    vi.stubEnv('AI_FREE', '');
  });

  it_('quote then pay: one signature of the buyer, SA last, verified on chain, 10 credits booked once', async () => {
    const b = await buyer();
    const { q, signed } = await quoteAndSign(b);
    expect(q.expected).toMatchObject({ buyer: b.kp.publicKey.toBase58(), feeWallet: w.feeWallet.publicKey.toBase58(), mint: w.usdc.toBase58(), amount: '1000000', feePayer: w.sa.publicKey.toBase58() });
    expect(q.expected.memo).toBe(`hp:credits:${q.purchaseId}`);
    expect((await svc.getPurchase(b.profile.id, q.purchaseId)).status).toBe('quoted');
    const feeBefore = w.usdcOf(w.feeWallet), buyerBefore = w.usdcOf(b.kp.publicKey);
    const v = AiPurchaseView.parse(await svc.pay(b.profile.id, { purchaseId: q.purchaseId, signedTxBase64: signed }));
    expect(v).toMatchObject({ status: 'settled', balance: 10, purchaseId: q.purchaseId });
    expect(v.explorerUrl).toContain(v.txSignature!);
    expect(v.explorerUrl!.includes('cluster=devnet')).toBe(cfg.cluster === 'devnet'); // the explorer link follows the cluster
    expect(w.usdcOf(w.feeWallet) - feeBefore).toBe(1_000_000n);
    expect(buyerBefore - w.usdcOf(b.kp.publicKey)).toBe(1_000_000n);
    expect(w.sol(b.kp)).toBe(0n);
    expect(spendCalls).toBe(1);
    const [row] = await db.select().from(schema.creditPurchases).where(eq(schema.creditPurchases.id, q.purchaseId));
    expect(row).toMatchObject({ status: 'settled', cluster: cfg.cluster, credits: 10, txSignature: v.txSignature });
    expect(await balanceOf(db, b.profile.id)).toBe(10);
    expect(AiCreditsResponse.parse(await svc.overview(b.profile.id)).packsLeftToday).toBe(2);
  });

  it_('paying twice, polling again and three parallel pays credit exactly once and send exactly once', async () => {
    const b = await buyer();
    const { q, signed } = await quoteAndSign(b);
    const results = await Promise.all([1, 2, 3].map(() => svc.pay(b.profile.id, { purchaseId: q.purchaseId, signedTxBase64: signed })));
    for (const r of results) expect(['settled', 'submitted']).toContain(r.status); // a parallel request that lost the claim sees "submitted" until the winner has finalized
    expect((await svc.getPurchase(b.profile.id, q.purchaseId)).status).toBe('settled');
    await svc.pay(b.profile.id, { purchaseId: q.purchaseId, signedTxBase64: signed });
    await svc.getPurchase(b.profile.id, q.purchaseId);
    expect(w.port.sent).toHaveLength(1);
    expect(await balanceOf(db, b.profile.id)).toBe(10);
    expect(await db.select().from(schema.creditLedger).where(eq(schema.creditLedger.profileId, b.profile.id))).toHaveLength(1);
    expect(await book(db, b.profile.id, 10, 'purchase', q.purchaseId)).toBe(false); // the ledger itself refuses a second booking
  });

  it_('a live quote is reused (double click); an expired one is replaced', async () => {
    const b = await buyer();
    const a = await svc.quote(b.profile), a2 = await svc.quote(b.profile);
    expect(a2.purchaseId).toBe(a.purchaseId);
    expect(a2.txBase64).toBe(a.txBase64);
    now = new Date(now.getTime() + 10 * 60_000);
    w.svm.expireBlockhash();
    expect((await svc.quote(b.profile)).purchaseId).not.toBe(a.purchaseId);
  });

  it_('without USDC there is no quote (insufficient_usdc), and the fee wallet cannot buy', async () => {
    const poor = await buyer(0n);
    await expect(svc.quote(poor.profile)).rejects.toMatchObject({ code: 'insufficient_usdc' });
    const half = await buyer(999_999n);
    await expect(svc.quote(half.profile)).rejects.toMatchObject({ code: 'insufficient_usdc' });
    const fee = await newProfile(w.feeWallet);
    await expect(svc.quote(fee)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it_('a tampered or foreign signature is refused and the purchase stays open: nothing sent, nothing credited', async () => {
    const b = await buyer();
    const { q } = await quoteAndSign(b);
    const bytes = new Uint8Array(Buffer.from(q.txBase64, 'base64'));
    const other = Keypair.generate();
    // signed by somebody else
    const wrong = walletSigns(bytes, w.sa); // SA's slot, not the buyer's
    await expect(svc.pay(b.profile.id, { purchaseId: q.purchaseId, signedTxBase64: Buffer.from(wrong).toString('base64') })).rejects.toMatchObject({ code: 'bad_signature' });
    // a different transaction (extra transfer) signed by the buyer
    const t2 = Transaction.from(bytes);
    t2.add((await import('@solana/web3.js')).SystemProgram.transfer({ fromPubkey: b.kp.publicKey, toPubkey: other.publicKey, lamports: 1 }));
    t2.signatures = []; t2.partialSign(b.kp);
    await expect(svc.pay(b.profile.id, { purchaseId: q.purchaseId, signedTxBase64: t2.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64') })).rejects.toMatchObject({ code: 'tx_mismatch' });
    expect(w.port.sent).toHaveLength(0);
    expect((await svc.getPurchase(b.profile.id, q.purchaseId)).status).toBe('quoted');
    expect(await balanceOf(db, b.profile.id)).toBe(0);
    expect(spendCalls).toBe(0); // SA signed nothing
  });

  it_("another wallet's purchase is 'not found' for read and pay", async () => {
    const a = await buyer(), c = await buyer();
    const { q, signed } = await quoteAndSign(a);
    await expect(svc.getPurchase(c.profile.id, q.purchaseId)).rejects.toMatchObject({ code: 'not_found' });
    await expect(svc.pay(c.profile.id, { purchaseId: q.purchaseId, signedTxBase64: signed })).rejects.toMatchObject({ code: 'not_found' });
  });

  it_('a round that ran out is expired (by our clock or by the chain height) and cannot be paid', async () => {
    const b = await buyer();
    const { q, signed } = await quoteAndSign(b);
    now = new Date(now.getTime() + 5 * 60_000);
    await expect(svc.pay(b.profile.id, { purchaseId: q.purchaseId, signedTxBase64: signed })).rejects.toMatchObject({ code: 'round_expired' });
    expect((await svc.getPurchase(b.profile.id, q.purchaseId)).status).toBe('expired');
    const { q: q2, signed: s2 } = await quoteAndSign(b);
    w.port.expireRound(); // the blockhash died on the chain while our clock says the round is open
    await expect(svc.pay(b.profile.id, { purchaseId: q2.purchaseId, signedTxBase64: s2 })).rejects.toMatchObject({ code: 'round_expired' });
    expect((await svc.getPurchase(b.profile.id, q2.purchaseId)).status).toBe('expired');
    expect(await balanceOf(db, b.profile.id)).toBe(0);
    expect(spendCalls).toBe(0);
  });

  it_('the sponsor budget of SA is checked before SA signs: refused means nothing is sent', async () => {
    const b = await buyer();
    const { q, signed } = await quoteAndSign(b);
    spendRefuse = true;
    await expect(svc.pay(b.profile.id, { purchaseId: q.purchaseId, signedTxBase64: signed })).rejects.toMatchObject({ code: 'rate_limited' });
    expect(w.port.sent).toHaveLength(0);
    expect((await svc.getPurchase(b.profile.id, q.purchaseId)).status).toBe('quoted');
    spendRefuse = false;
    expect((await svc.pay(b.profile.id, { purchaseId: q.purchaseId, signedTxBase64: signed })).status).toBe('settled'); // the same signed message still works
  });

  it_('a payment that fails simulation spends no sponsor budget, however often it is retried', async () => {
    const b = await buyer();
    const { q, signed } = await quoteAndSign(b);
    const real = w.port.simulate;
    w.port.simulate = async () => ({ err: 'InsufficientFunds', logs: ['Program log: Error: insufficient funds'] });
    try {
      for (let i = 0; i < 3; i++) await expect(svc.pay(b.profile.id, { purchaseId: q.purchaseId, signedTxBase64: signed })).rejects.toMatchObject({ code: 'insufficient_usdc' });
    } finally { w.port.simulate = real; }
    expect(spendCalls).toBe(0);
    expect(w.port.sent).toHaveLength(0);
    expect((await svc.pay(b.profile.id, { purchaseId: q.purchaseId, signedTxBase64: signed })).status).toBe('settled');
    expect(spendCalls).toBe(1);
  });

  it_('an RPC that dies after accepting the transaction: the purchase is submitted, then settles from the chain on the next read, credited once', async () => {
    const b = await buyer();
    const { q, signed } = await quoteAndSign(b);
    w.port.dieAfterLanding = true;
    const v = await svc.pay(b.profile.id, { purchaseId: q.purchaseId, signedTxBase64: signed });
    expect(['submitted', 'settled']).toContain(v.status);
    expect((await svc.getPurchase(b.profile.id, q.purchaseId)).status).toBe('settled');
    expect(await balanceOf(db, b.profile.id)).toBe(10);
  });

  it_('a transaction that landed with other effects than quoted is FAILED and credits nothing', async () => {
    const b = await buyer();
    const { q, signed } = await quoteAndSign(b);
    w.port.tamper = (tx) => { const c = structuredClone(tx); for (const bal of c.meta!.postTokenBalances ?? []) if (bal.owner === w.feeWallet.publicKey.toBase58()) bal.uiTokenAmount.amount = '1'; return c; };
    const v = await svc.pay(b.profile.id, { purchaseId: q.purchaseId, signedTxBase64: signed });
    expect(v.status).toBe('failed');
    expect(await balanceOf(db, b.profile.id)).toBe(0);
    const [row] = await db.select().from(schema.creditPurchases).where(eq(schema.creditPurchases.id, q.purchaseId));
    expect(row!.failureCode).toBe('delta_mismatch');
  });

  it_('a wrong memo on chain also fails (the purchase id is the memo)', async () => {
    const b = await buyer();
    const { q, signed } = await quoteAndSign(b);
    w.port.tamper = (tx) => { const c = structuredClone(tx); c.transaction.message.instructions = c.transaction.message.instructions!.map((i) => (i.program === 'spl-memo' ? { ...i, parsed: 'hp:credits:someone-else' } : i)); return c; };
    expect((await svc.pay(b.profile.id, { purchaseId: q.purchaseId, signedTxBase64: signed })).status).toBe('failed');
    expect(await balanceOf(db, b.profile.id)).toBe(0);
  });

  it_('a daily limit of packs per wallet: the third quote is refused with the time until midnight (UTC)', async () => {
    const limited = make({ packsPerDay: 2 });
    const b = await buyer(10_000_000n);
    for (let i = 0; i < 2; i++) {
      const q = await limited.quote(b.profile);
      const signed = Buffer.from(walletSigns(new Uint8Array(Buffer.from(q.txBase64, 'base64')), b.kp)).toString('base64');
      expect((await limited.pay(b.profile.id, { purchaseId: q.purchaseId, signedTxBase64: signed })).status).toBe('settled');
    }
    expect((await limited.overview(b.profile.id)).packsLeftToday).toBe(0);
    const e = await limited.quote(b.profile).catch((x) => x);
    expect(e).toMatchObject({ code: 'rate_limited' });
    expect(e.extra.retryAfterS).toBe(14 * 3600); // 10:00 -> 24:00 UTC
    now = new Date('2030-05-06T00:00:01Z'); // the next UTC day
    expect(await limited.quote(b.profile)).toBeTruthy();
  });

  it_('a cluster this deployment does not serve is refused by the guard (assertCluster), before any chain call', async () => {
    const guarded = createCreditService({ db, chainFor: () => { throw new Error('chain must not be touched'); }, sa: w.sa, usdcMint: () => w.usdc.toBase58(), feeWallet: w.feeWallet.publicKey.toBase58(), cluster: cfg.cluster, packsPerDay: 3,
      assertCluster: () => { throw new ApiError('mainnet_config_incomplete', 'not set up'); } });
    const b = await buyer();
    await expect(guarded.quote(b.profile)).rejects.toMatchObject({ code: 'mainnet_config_incomplete' });
  });
});

describe('the mint follows the cluster and never crosses over', () => {
  it('mainnet always uses the real USDC mint and refuses a configured test mint; devnet uses its own', () => {
    expect(usdcMintFor('mainnet-beta', {})).toBe(MAINNET_USDC_MINT);
    expect(() => usdcMintFor('mainnet-beta', { USDC_MINT: Keypair.generate().publicKey.toBase58() })).toThrow(ConfigError);
    const test = Keypair.generate().publicKey.toBase58();
    expect(usdcMintFor('devnet', { USDC_MINT: test })).toBe(test);
  });
});
