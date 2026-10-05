/**
 * AI credit purchases (FEATURE_AI): 1 USDC buys 10 listing drafts, paid on chain, booked only after the chain says so.
 *
 *   quote  : the server builds the ONE legal transaction (fee payer SA, signers {SA, buyer}) and stores it as a `quoted` row (a live quote is reused)
 *   pay    : the buyer's signature is checked against the prepared message, SA signs last, the row is claimed (`quoted` -> `submitted`, one winner),
 *            simulated, sent
 *   finalize: `settled` and the ledger booking happen in ONE database transaction and only when the confirmed transaction's USDC deltas (for the
 *            mint of the cluster) and its memo match; a transaction that landed with other effects is `failed`, never credited.
 * Unique (reason, ref) in the ledger and a unique tx signature make a retry or a second poll harmless. Nothing here names a cluster: the mint,
 * the fee wallet and the explorer come from lib/chain/config.ts and explorer.ts through the deps.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Keypair } from '@solana/web3.js';
import type { db as DbInstance } from '@/db';
import { creditPurchases } from '@/db/schema';
import type { z } from 'zod';
import { AI_PACK_CREDITS, AI_PACK_PRICE_USDC, ApiError, type AiCreditsQuoteResponse as QuoteSchema, type AiCreditsResponse as OverviewSchema, type AiPurchaseView as ViewSchema, type Cluster } from '@/contracts';

type AiCreditsResponse = z.infer<typeof OverviewSchema>;
type AiCreditsQuoteResponse = z.infer<typeof QuoteSchema>;
type AiPurchaseView = z.infer<typeof ViewSchema>;
import { assembleCreditTx, extractBuyerSignature } from '@/lib/chain/credit-sign';
import { buildUnsignedCreditTx, creditMemo, ExpectedCredit } from '@/lib/chain/credit-tx';
import { verifyCreditPaid } from '@/lib/chain/credit-verify';
import { explorerTxUrl } from '@/lib/chain/explorer';
import { invalidateBalance } from '@/lib/chain/funds';
import type { ChainPort } from '@/lib/chain/port';
import { aiConfigured, aiFree } from '../ai/config';
import { balanceOf, book } from './ledger';

type Db = typeof DbInstance;
type Row = typeof creditPurchases.$inferSelect;

export const CREDIT_ROUND_S = 90;
const SEND_POLL_TIMEOUT_MS = 20_000;

export interface CreditDeps {
  db: Db;
  chainFor: (cluster: Cluster) => ChainPort;
  /** SA: fee payer, rent payer, second signer. No authority over the buyer's USDC. */
  sa: Keypair;
  usdcMint: (cluster: Cluster) => string;
  feeWallet: string;
  /** The cluster this deployment serves. */
  cluster: Cluster;
  /** Credit packs one wallet may buy per UTC day (lib: packsPerWalletDay). */
  packsPerDay: number;
  now?: () => Date;
  roundS?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Refuses (throws) when the deployment cannot move money on `cluster` (production: assertClusterReady). */
  assertCluster?: (cluster: Cluster) => void;
  /** Called right before SA signs: the daily cap of sponsored purchases (production: a shared counter). Throws to refuse. */
  spendGuard?: () => Promise<void>;
  /** Whether a model key (or the mock) is configured; defaults to the environment. */
  configured?: () => boolean;
}

export interface CreditService {
  overview(profileId: string): Promise<AiCreditsResponse>;
  quote(profile: { id: string; walletAddress: string }): Promise<AiCreditsQuoteResponse>;
  pay(profileId: string, input: { purchaseId: string; signedTxBase64: string }): Promise<AiPurchaseView>;
  getPurchase(profileId: string, purchaseId: string): Promise<AiPurchaseView>;
}

export function buildExpectedCredit(i: { purchaseId: string; cluster: Cluster; buyer: string; feePayer: string; feeWallet: string; usdcMint: string; amount: bigint }): ExpectedCredit {
  return ExpectedCredit.parse({ purchaseId: i.purchaseId, cluster: i.cluster, buyer: i.buyer, feePayer: i.feePayer, feeWallet: i.feeWallet, usdcMint: i.usdcMint, amount: i.amount.toString(), memo: creditMemo(i.purchaseId) });
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export function createCreditService(deps: CreditDeps): CreditService {
  const { db, sa } = deps;
  const now = () => (deps.now ?? (() => new Date()))();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const guard = deps.assertCluster ?? (() => undefined);
  const roundS = deps.roundS ?? CREDIT_ROUND_S;
  const amount = BigInt(AI_PACK_PRICE_USDC);

  const expectedFor = (row: Row): ExpectedCredit =>
    buildExpectedCredit({ purchaseId: row.id, cluster: row.cluster as Cluster, buyer: row.wallet, feePayer: sa.publicKey.toBase58(), feeWallet: deps.feeWallet, usdcMint: deps.usdcMint(row.cluster as Cluster), amount: row.amount });

  async function load(id: string, profileId: string): Promise<Row> {
    const [row] = await db.select().from(creditPurchases).where(eq(creditPurchases.id, id));
    if (!row || row.profileId !== profileId) throw new ApiError('not_found', 'no such purchase'); // someone else's purchase is "not found", not "forbidden"
    return row;
  }

  async function view(row: Row): Promise<AiPurchaseView> {
    return {
      purchaseId: row.id, status: row.status as AiPurchaseView['status'], balance: await balanceOf(db, row.profileId),
      ...(row.txSignature ? { txSignature: row.txSignature, explorerUrl: explorerTxUrl(row.txSignature, row.cluster as Cluster) } : {}),
    };
  }

  async function packsUsedToday(profileId: string): Promise<number> {
    const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(creditPurchases)
      .where(and(eq(creditPurchases.profileId, profileId), inArray(creditPurchases.status, ['submitted', 'settled']), gte(creditPurchases.createdAt, startOfUtcDay(now()))));
    return r?.n ?? 0;
  }

  async function overview(profileId: string): Promise<AiCreditsResponse> {
    return {
      balance: await balanceOf(db, profileId), pack: { credits: AI_PACK_CREDITS, priceUsdc: AI_PACK_PRICE_USDC },
      packsLeftToday: Math.max(0, deps.packsPerDay - (await packsUsedToday(profileId))), cluster: deps.cluster, configured: (deps.configured ?? (() => aiConfigured()))(), free: aiFree(),
    };
  }

  const quoteView = (row: Row): AiCreditsQuoteResponse => {
    const e = expectedFor(row);
    return { purchaseId: row.id, txBase64: row.preparedMessage!, expected: { feePayer: e.feePayer, buyer: e.buyer, feeWallet: e.feeWallet, mint: e.usdcMint, amount: e.amount, memo: e.memo }, roundExpiresAt: row.roundExpiresAt!.toISOString() };
  };

  async function quote(profile: { id: string; walletAddress: string }): Promise<AiCreditsQuoteResponse> {
    const cluster = deps.cluster;
    guard(cluster);
    // A live quote of this buyer is reused (a double click, a second tab): same message, same purchase.
    const [live] = await db.select().from(creditPurchases)
      .where(and(eq(creditPurchases.profileId, profile.id), eq(creditPurchases.status, 'quoted'), eq(creditPurchases.cluster, cluster), sql`${creditPurchases.roundExpiresAt} > ${now()}`)).limit(1);
    if (live) return quoteView(live);

    if ((await packsUsedToday(profile.id)) >= deps.packsPerDay) {
      const midnight = startOfUtcDay(new Date(now().getTime() + 86_400_000));
      throw new ApiError('rate_limited', `You have reached today's limit of credit purchases (${deps.packsPerDay}).`, { retryAfterS: Math.max(1, Math.ceil((midnight.getTime() - now().getTime()) / 1000)) });
    }
    if (profile.walletAddress === deps.feeWallet || profile.walletAddress === sa.publicKey.toBase58()) throw new ApiError('forbidden', 'This wallet cannot buy credits.');

    const chain = deps.chainFor(cluster);
    if ((await chain.getUsdcBalance(profile.walletAddress)) < amount) throw new ApiError('insufficient_usdc', 'Your wallet does not hold enough USDC for a credit pack.');
    const [bh, height] = await Promise.all([chain.getLatestBlockhash(), chain.getBlockHeight()]);
    const validS = Math.floor((bh.lastValidBlockHeight - height) * 0.4);
    if (validS < 10) throw new ApiError('rpc_unavailable', 'The latest blockhash is too old, try again.');

    const id = randomUUID();
    const expected = buildExpectedCredit({ purchaseId: id, cluster, buyer: profile.walletAddress, feePayer: sa.publicKey.toBase58(), feeWallet: deps.feeWallet, usdcMint: deps.usdcMint(cluster), amount });
    const txBytes = buildUnsignedCreditTx(expected, bh.blockhash);
    const [row] = await db.insert(creditPurchases).values({
      id, profileId: profile.id, wallet: profile.walletAddress, cluster, credits: AI_PACK_CREDITS, amount, status: 'quoted',
      preparedMessage: b64(txBytes), preparedBlockhash: bh.blockhash, lastValidHeight: bh.lastValidBlockHeight, roundExpiresAt: new Date(now().getTime() + Math.min(roundS, validS) * 1000), memo: expected.memo, createdAt: now(),
    }).returning();
    return quoteView(row!);
  }

  async function finalize(row: Row): Promise<Row> {
    if (row.status !== 'submitted' || !row.txSignature) return row;
    const chain = deps.chainFor(row.cluster as Cluster);
    const settle = (status: 'failed' | 'expired', code: string) =>
      db.update(creditPurchases).set({ status, failureCode: code }).where(and(eq(creditPurchases.id, row.id), eq(creditPurchases.status, 'submitted'))).returning().then((r) => r[0] ?? row);
    const st = await chain.getSignatureStatus(row.txSignature);
    if (!st) return (await chain.getBlockHeight()) > (row.lastValidHeight ?? 0) ? settle('expired', 'never_landed') : row;
    if (!st.confirmed) return row;
    if (st.err) return settle('failed', 'tx_failed');
    const parsed = await chain.getTransaction(row.txSignature);
    if (!parsed) return row; // not indexed yet; ask again
    const verdict = verifyCreditPaid(parsed, expectedFor(row));
    if (!verdict.ok) { console.warn('credit purchase did not verify', row.id, verdict.code); return settle('failed', verdict.code); }
    return db.transaction(async (tx) => {
      const [done] = await tx.update(creditPurchases).set({ status: 'settled', settledAt: now(), failureCode: null }).where(and(eq(creditPurchases.id, row.id), eq(creditPurchases.status, 'submitted'))).returning();
      if (!done) return row;
      await book(tx, row.profileId, row.credits, 'purchase', row.id); // unique (reason, ref): a second finalize books nothing
      return done;
    }).then((r) => { invalidateBalance(row.wallet); return r; });
  }

  async function pay(profileId: string, input: { purchaseId: string; signedTxBase64: string }): Promise<AiPurchaseView> {
    let row = await load(input.purchaseId, profileId);
    if (row.status === 'submitted') return view(await finalize(row));
    if (row.status !== 'quoted') {
      if (row.status === 'settled') return view(row);
      throw new ApiError('wrong_state', `purchase is ${row.status}`);
    }
    guard(row.cluster as Cluster);
    if (!row.roundExpiresAt || row.roundExpiresAt <= now()) {
      await db.update(creditPurchases).set({ status: 'expired', failureCode: 'round_expired' }).where(and(eq(creditPurchases.id, row.id), eq(creditPurchases.status, 'quoted')));
      throw new ApiError('round_expired', 'The signing round has ended. Start the purchase again.');
    }
    const e = expectedFor(row);
    const prepared = unb64(row.preparedMessage!);
    const buyerSig = extractBuyerSignature(unb64(input.signedTxBase64), prepared, e);
    const chain = deps.chainFor(row.cluster as Cluster);
    if ((await chain.getBlockHeight()) > (row.lastValidHeight ?? 0)) {
      await db.update(creditPurchases).set({ status: 'expired', failureCode: 'round_expired' }).where(and(eq(creditPurchases.id, row.id), eq(creditPurchases.status, 'quoted')));
      throw new ApiError('round_expired', 'The signing round ended before the transaction could be sent. Start the purchase again.');
    }
    const { wire, signature } = assembleCreditTx(prepared, e, buyerSig, sa);
    const wire64 = b64(wire);

    const sim = await chain.simulate(wire64);
    if (sim.err) {
      const winner = await load(row.id, profileId);
      if (winner.status !== 'quoted') return view(await finalize(winner)); // a concurrent request already sent it
      const text = `${JSON.stringify(sim.err)} ${sim.logs.join(' ')}`;
      console.warn('credit purchase simulation failed', row.id, text.slice(0, 400));
      throw new ApiError(/insufficient funds|InsufficientFunds|custom program error: 0x1\b/i.test(text) ? 'insufficient_usdc' : 'simulation_failed', 'The network rejected the payment in simulation.');
    }

    await deps.spendGuard?.(); // only for a transaction that passed simulation: failing attempts cost the budget nothing
    let claimed: Row | undefined;
    try {
      [claimed] = await db.update(creditPurchases).set({ status: 'submitted', txSignature: signature })
        .where(and(eq(creditPurchases.id, row.id), eq(creditPurchases.status, 'quoted'), sql`${creditPurchases.txSignature} is null`)).returning();
    } catch {
      throw new ApiError('wrong_state', 'this transaction is already recorded');
    }
    if (!claimed) return view(await finalize(await load(row.id, profileId)));
    row = claimed;

    try {
      const sent = await chain.send(wire64);
      if (sent !== signature) throw new ApiError('simulation_failed', 'the node returned a different signature');
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'blockhash_expired' || err.code === 'simulation_failed')) {
        await db.update(creditPurchases).set({ status: 'expired', failureCode: err.code }).where(and(eq(creditPurchases.id, row.id), eq(creditPurchases.status, 'submitted')));
        throw err.code === 'blockhash_expired' ? new ApiError('round_expired', 'The signing round ended before the transaction could be sent. Start the purchase again.') : err;
      }
      // Outcome unknown (RPC down mid-send): it may have landed. Stay `submitted`; finalize decides from the chain.
    }
    const deadline = Date.now() + SEND_POLL_TIMEOUT_MS;
    // A slow node must not turn a sent payment into an error: while the chain is unreachable the row simply stays `submitted`.
    const soft = async (): Promise<Row> => { const r = await load(row.id, profileId); return finalize(r).catch((e) => { if (e instanceof ApiError && e.code === 'rpc_unavailable') return r; throw e; }); };
    let cur = await soft();
    while (cur.status === 'submitted' && Date.now() < deadline) {
      await sleep(deps.pollMs ?? 1000);
      cur = await soft();
    }
    return view(cur);
  }

  async function getPurchase(profileId: string, purchaseId: string): Promise<AiPurchaseView> {
    const row = await load(purchaseId, profileId);
    try {
      return await view(await finalize(row));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'rpc_unavailable') return view(row); // a read never fails because the chain is slow
      throw e;
    }
  }

  return { overview, quote, pay, getPurchase };
}

// ---- the production instance: built on first use so importing this module never needs DATABASE_URL or keys ------------------------------

let instance: CreditService | undefined;
let override: CreditService | undefined;
/** Tests inject a service built on LiteSVM; pass undefined to go back to the real one. */
export const setCreditService = (s?: CreditService): void => { override = s; };

export function getCreditService(): CreditService {
  if (override) return override;
  if (instance) return instance;
  let real: Promise<CreditService> | undefined;
  const get = () => (real ??= (async () => {
    const [{ db }, cfg, keys, clusterMod, port, rpc, ai, rate] = await Promise.all([
      import('@/db'), import('@/lib/chain/config'), import('@/lib/chain/keys'), import('@/lib/chain/cluster'), import('@/lib/chain/port'), import('@/lib/chain/rpc'), import('../ai/config'), import('@/lib/http/ratelimit'),
    ]);
    const { ChainError } = await import('@/lib/chain/errors');
    cfg.assertFeePayerPlatform();
    const fee = cfg.feeWalletAddress();
    if (!fee) throw new ChainError('paused', 'Payments are paused: the platform wallet is not configured.');
    const cluster = cfg.resolveCluster();
    return createCreditService({
      db, chainFor: (c) => port.createRpcPort(c, rpc.makeRpc(c, { timeoutMs: 6000 })), sa: keys.settlementAuthority(), usdcMint: (c) => cfg.usdcMintFor(c), feeWallet: fee, cluster,
      packsPerDay: ai.packsPerWalletDay(cluster === 'mainnet-beta'), assertCluster: (c) => clusterMod.assertClusterReady(c),
      spendGuard: async () => rate.assertRate(await rate.rateLimit('g:sa-credit-purchase', ai.saCreditPurchasesPerDay(), 86_400)),
    });
  })().catch((e) => { real = undefined; throw e; })); // a failed start is not remembered
  instance = {
    overview: async (...a) => (await get()).overview(...a),
    quote: async (...a) => (await get()).quote(...a),
    pay: async (...a) => (await get()).pay(...a),
    getPurchase: async (...a) => (await get()).getPurchase(...a),
  };
  return instance;
}
