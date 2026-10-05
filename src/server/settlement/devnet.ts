/**
 * Devnet helpers behind /api/devnet/*: the test-USDC faucet, the demo-card mint and the metadata the cards point at.
 *
 *  - Devnet only: on any other cluster every call is `not_found`, before anything else runs.
 *  - SA pays rent and fees. Below 0.5 SOL both helpers pause (`faucet_paused`, `mint_paused`) so a drained account never
 *    blocks a settlement. No route reports the balance (only /api/health's coarse status does).
 *  - Limits live in the `rate_limits` table (atomic, shared by every instance). A request that fails before the chain accepted
 *    anything gives its allowance back, so a flaky RPC does not cost a visitor their daily claim. Fixed window: the counters
 *    reset at 00:00 UTC, so in the worst case a visitor gets two claims within a few minutes around midnight (Known limit: a
 *    rolling window needs a claims table; not worth it for test money).
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Keypair } from '@solana/web3.js';
import { Keypair as Kp } from '@solana/web3.js';
import type { db as DbInstance } from '@/db';
import { auditLogs, devnetAssets, rateLimits } from '@/db/schema';
import type { z } from 'zod';
import { ApiError, DevnetMetadata, type Cluster, type ErrorCode } from '@/contracts';
import { resolveCluster, usdcMintFor } from '@/lib/chain/config';
import { CARD_SYMBOL, CARD_TEMPLATES, REPLICA_LABEL, normalizeTraits, replicaName, templateById, traitsOf, type Trait } from '@/lib/chain/devnet-cards';
import { FAUCET_AMOUNT, MIN_SA_LAMPORTS, faucetInstructions, mintCardInstructions, rpcDevnetIo, vaultCollection, type DevnetIo } from '@/lib/chain/devnet';
import { invalidateBalance } from '@/lib/chain/funds';
import { faucetMintAuthority, settlementAuthority } from '@/lib/chain/keys';
import { makeRpc } from '@/lib/chain/rpc';
import { rateLimit, clientIp } from '@/lib/http/ratelimit';

type Db = typeof DbInstance;
const DAY_S = 86_400;
/**
 * Whatever the per-wallet and per-address limits say, sign-in is free, so the number of wallets is unbounded: these two caps are what
 * bounds the SOL that anonymous visitors can make SA spend per day (about 0.002 SOL per claim, 0.003 per card: at most ~0.9 SOL a day).
 */
export const GLOBAL_FAUCET_PER_DAY = 200;
export const GLOBAL_MINT_PER_DAY = 150;

export interface DevnetDeps {
  db: Db;
  io: DevnetIo;
  cluster: Cluster;
  sa: Keypair;
  faucetAuthority: Keypair;
  usdcMint: string;
  collection: string;
  now?: () => number;
  pick?: (n: number) => number;
}

export interface DevnetService {
  faucet(i: { wallet: string; req: Request }): Promise<{ mint: string; amount: string; signature: string }>;
  mintCard(i: { wallet: string; req: Request; origin: string; template?: string }): Promise<{ mint: string; name: string; signature: string }>;
  /**
   * The devnet demo pack: mints a copy of the replica `source` (a `devnet_assets` card, same name, image and traits) into `wallet`. The same mint and the same SOL guard as
   * `mintCard`, without its per-wallet, per-address and global limits (the demo pack has its own daily cap per wallet).
   */
  mintCopy(i: { wallet: string; origin: string; source: string }): Promise<{ mint: string; name: string; signature: string }>;
  metadata(mint: string, origin: string): Promise<z.infer<typeof DevnetMetadata> | null>;
}

/** The JSON a card's on-chain URI points at. Needs only the database (no key), so a wallet can always fetch it. */
export async function readMetadata(db: Db, mint: string, origin: string): Promise<z.infer<typeof DevnetMetadata> | null> {
  if (mint === 'collection') return DevnetMetadata.parse({ name: 'Hammerprice Devnet Vault', symbol: CARD_SYMBOL, image: `${origin}/icons/icon-512.png`, description: REPLICA_LABEL, attributes: [] });
  const [row] = await db.select().from(devnetAssets).where(eq(devnetAssets.mint, mint));
  if (!row) return null;
  return DevnetMetadata.parse({ name: row.name, symbol: CARD_SYMBOL, image: row.imageUrl ?? `${origin}/icons/icon-512.png`, description: REPLICA_LABEL, attributes: normalizeTraits(row.attributes) });
}

export function createDevnetService(deps: DevnetDeps): DevnetService {
  const { db, io, sa } = deps;
  const now = () => (deps.now ?? Date.now)();
  const pick = deps.pick ?? ((n: number) => Math.floor(Math.random() * n));

  const onlyDevnet = () => {
    if (deps.cluster !== 'devnet') throw new ApiError('not_found', 'Not available on this network');
  };
  const guardSol = async (code: ErrorCode, what: string) => {
    if ((await io.saLamports(sa.publicKey.toBase58())) < MIN_SA_LAMPORTS) throw new ApiError(code, `${what} is paused while the platform tops up its test SOL. Try again later.`);
  };

  /** Takes one allowance from each counter; a refusal gives back what was already taken. Returns a function that gives all of them back. */
  async function take(counters: { key: string; limit: number; windowS: number; text: string }[]): Promise<() => Promise<void>> {
    const taken: typeof counters = [];
    const giveBack = async (list = taken) => {
      for (const c of list) {
        const windowMs = c.windowS * 1000, start = new Date(Math.floor(now() / windowMs) * windowMs);
        await db.update(rateLimits).set({ count: sql`greatest(${rateLimits.count} - 1, 0)` }).where(and(eq(rateLimits.key, c.key), eq(rateLimits.windowStart, start))).catch(() => undefined);
      }
    };
    for (const c of counters) {
      const r = await rateLimit(c.key, c.limit, c.windowS, { nowMs: now() });
      taken.push(c); // the counter moved even when it refused, so it is given back too
      if (!r.ok) {
        await giveBack();
        throw new ApiError('rate_limited', c.text, { retryAfterS: r.retryAfterS });
      }
    }
    return () => giveBack();
  }

  async function faucet({ wallet, req }: { wallet: string; req: Request }) {
    onlyDevnet();
    // The limits come BEFORE the first RPC call (the SA balance read): a signed-in script must not be able to spend our RPC quota by asking again and again.
    const release = await take([
      { key: `w:faucet:${wallet}`, limit: 1, windowS: DAY_S, text: 'You can claim test USDC once every 24 hours. Try again later.' },
      { key: `ip:faucet:${clientIp(req)}`, limit: 3, windowS: DAY_S, text: 'This network has claimed test USDC too often today. Try again tomorrow.' },
      { key: 'g:faucet', limit: GLOBAL_FAUCET_PER_DAY, windowS: DAY_S, text: 'The test faucet has reached its daily limit. Try again tomorrow.' },
    ]);
    let signature: string;
    try {
      await guardSol('faucet_paused', 'The test faucet');
      signature = await io.send(faucetInstructions({ sa: sa.publicKey, mintAuthority: deps.faucetAuthority.publicKey, mint: deps.usdcMint, wallet }), sa, [deps.faucetAuthority]);
    } catch (e) {
      await release();
      throw e;
    }
    invalidateBalance(wallet, 'devnet');
    await db.insert(auditLogs).values({ action: 'devnet.faucet', actorWallet: wallet, target: signature, detail: { amount: FAUCET_AMOUNT.toString() } }).catch(() => undefined);
    return { mint: deps.usdcMint, amount: FAUCET_AMOUNT.toString(), signature };
  }

  async function mintCard({ wallet, req, origin, template }: { wallet: string; req: Request; origin: string; template?: string }) {
    onlyDevnet();
    const t = template === undefined ? CARD_TEMPLATES[pick(CARD_TEMPLATES.length)]! : templateById(template);
    if (!t) throw new ApiError('validation', `Unknown card template. Choose one of: ${CARD_TEMPLATES.map((c) => c.id).join(', ')}`);
    const release = await take([
      { key: `w:mint-card:${wallet}`, limit: 3, windowS: DAY_S, text: 'You can mint 3 demo cards per day. Try again tomorrow.' },
      { key: `ip:mint-card:${clientIp(req)}`, limit: 10, windowS: DAY_S, text: 'This network has minted too many demo cards today. Try again tomorrow.' },
      { key: 'g:mint-card', limit: GLOBAL_MINT_PER_DAY, windowS: DAY_S, text: 'Demo card minting has reached its daily limit. Try again tomorrow.' },
    ]);
    let minted: { mint: string; name: string; signature: string };
    try {
      await guardSol('mint_paused', 'Minting demo cards');
      minted = await mintInto(wallet, origin, { name: replicaName(t), imageUrl: t.imageUrl, attributes: traitsOf(t) });
    } catch (e) {
      await release();
      throw e;
    }
    await db.insert(auditLogs).values({ action: 'devnet.mint-card', actorWallet: wallet, target: minted.mint, detail: { template: t.id, signature: minted.signature } }).catch(() => undefined);
    return minted;
  }

  /** One new Core replica owned by `wallet` from birth. The row goes in first so the metadata URL answers as soon as the card exists; it is removed again if the chain refuses. */
  async function mintInto(wallet: string, origin: string, card: { name: string; imageUrl: string | null; attributes: Trait[] }) {
    const asset = Kp.generate(), mint = asset.publicKey.toBase58();
    await db.insert(devnetAssets).values({ mint, ownerWallet: wallet, name: card.name, imageUrl: card.imageUrl, attributes: card.attributes });
    try {
      const signature = await io.send(mintCardInstructions({ sa, collection: deps.collection, asset, owner: wallet, name: card.name, uri: `${origin}/api/devnet/metadata/${mint}`, attributes: card.attributes }), sa, [asset]);
      return { mint, name: card.name, signature };
    } catch (e) {
      await db.delete(devnetAssets).where(eq(devnetAssets.mint, mint)).catch(() => undefined);
      throw e;
    }
  }

  async function mintCopy({ wallet, origin, source }: { wallet: string; origin: string; source: string }) {
    onlyDevnet();
    const [row] = await db.select().from(devnetAssets).where(eq(devnetAssets.mint, source));
    if (!row) throw new ApiError('not_found', 'No such demo card');
    await guardSol('mint_paused', 'Minting demo cards');
    const minted = await mintInto(wallet, origin, { name: row.name, imageUrl: row.imageUrl, attributes: normalizeTraits(row.attributes) });
    await db.insert(auditLogs).values({ action: 'devnet.mint-copy', actorWallet: wallet, target: minted.mint, detail: { source, signature: minted.signature } }).catch(() => undefined);
    return minted;
  }

  return { faucet, mintCard, mintCopy, metadata: (mint, origin) => readMetadata(db, mint, origin) };
}

// ---- the production instance (built on first use: importing this module needs neither a database nor keys) -------------------

let override: DevnetService | undefined;
let instance: DevnetService | undefined;
/** Tests inject a service built on LiteSVM; pass undefined to go back to the real one. */
export function setDevnetService(s?: DevnetService): void {
  override = s;
}

/** On any cluster but devnet nothing is built and no key is read: every call is `not_found`. */
const notHere: DevnetService = {
  faucet: async () => { throw new ApiError('not_found', 'Not available on this network'); },
  mintCard: async () => { throw new ApiError('not_found', 'Not available on this network'); },
  mintCopy: async () => { throw new ApiError('not_found', 'Not available on this network'); },
  metadata: async () => null,
};

export function getDevnetService(): DevnetService {
  if (override) return override;
  if (instance) return instance;
  if (resolveCluster() !== 'devnet') return (instance = notHere);
  let real: Promise<DevnetService> | undefined;
  const get = () => (real ??= import('@/db').then(({ db }) => {
    const sa = settlementAuthority();
    return createDevnetService({ db, io: rpcDevnetIo(makeRpc('devnet', { timeoutMs: 6000 })), cluster: 'devnet', sa, faucetAuthority: faucetMintAuthority(), usdcMint: usdcMintFor('devnet'), collection: vaultCollection(sa) });
  }).catch((e) => { real = undefined; throw e; })); // a failed start is not remembered
  return (instance = {
    faucet: async (i) => (await get()).faucet(i),
    mintCard: async (i) => (await get()).mintCard(i),
    mintCopy: async (i) => (await get()).mintCopy(i),
    metadata: async (m, o) => readMetadata((await import('@/db')).db, m, o),
  });
}
