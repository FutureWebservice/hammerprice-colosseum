/**
 * "Your cards" for the seller's picker (GET /api/sell/assets).
 *
 *  - mainnet: the wallet's Core assets inside Collector Crypt's collection, from public DAS (an index: good for a picker, never
 *    for a decision; consign and settlement re-read the account).
 *  - devnet: the replicas minted to the wallet and the ones it won in a settled sale (the `devnet_assets` table), each with an on-chain owner read.
 * Each card is flagged eligible with its reason codes (contracts/chain.ts READINESS_REASONS); the words for them live in the UI.
 */
import { and, desc, eq, inArray, isNotNull, or } from 'drizzle-orm';
import type { db as DbInstance } from '@/db';
import { devnetAssets, lots, settlements } from '@/db/schema';
import type { AssetInfo, Cluster, ConsignStatus, SellAsset } from '@/contracts';
import { evaluateAssetReadiness } from '@/lib/chain/asset';
import { CC_MAINNET_COLLECTION } from '@/lib/chain/config';
import { assetsByOwner } from '@/lib/chain/das';
import { normalizeTraits } from '@/lib/chain/devnet-cards';
import { createRpcPort, type ChainPort } from '@/lib/chain/port';
import { findListings, type Listing } from '@/server/assets/listed';

type Db = typeof DbInstance;
const MAX_CARDS = 50;
const READ_PARALLEL = 5; // the public devnet RPC rate-limits bursts

export interface SellDeps {
  db: Db;
  chainFor: (cluster: Cluster) => Pick<ChainPort, 'readAsset'>;
  das?: (wallet: string) => Promise<AssetInfo[]>;
}

export interface SellService {
  listAssets(i: { wallet: string; profileId: string; cluster: Cluster }): Promise<SellAsset[]>;
}

export function createSellService(deps: SellDeps): SellService {
  const das = deps.das ?? ((wallet: string) => assetsByOwner(wallet, { collection: CC_MAINNET_COLLECTION }));

  async function consignOf(profileId: string, mints: string[]): Promise<Map<string, ConsignStatus>> {
    const out = new Map<string, ConsignStatus>();
    if (mints.length === 0) return out;
    const rows = await deps.db.select({ mint: lots.mintAddress, c: lots.consignStatus }).from(lots)
      .where(and(eq(lots.sellerId, profileId), inArray(lots.mintAddress, mints), inArray(lots.state, ['catalogued', 'open']))).orderBy(desc(lots.openedAt));
    for (const r of rows) if (!out.has(r.mint) || r.c === 'ready') out.set(r.mint, r.c as ConsignStatus);
    return out;
  }

  /** Where each card is offered right now (a room or a pack): the picker greys those out, and createShow refuses them. */
  async function listedOf(mints: string[]): Promise<Map<string, Listing>> {
    return findListings(deps.db, mints);
  }
  /** A card that is offered elsewhere is not eligible (reason already_listed) and says where, so every picker greys it out the same way. */
  const withListing = (a: Omit<SellAsset, 'listed'>, l: Listing | undefined): SellAsset =>
    !l ? { ...a, listed: null } : { ...a, eligible: false, reasons: a.reasons.includes('already_listed') ? a.reasons : [...a.reasons, 'already_listed'], listed: l.kind === 'lot' ? { kind: 'lot', showId: l.showId } : { kind: 'pack', packId: l.packId } };

  async function listAssets({ wallet, profileId, cluster }: { wallet: string; profileId: string; cluster: Cluster }): Promise<SellAsset[]> {
    if (cluster === 'mainnet-beta') {
      const infos = (await das(wallet)).slice(0, MAX_CARDS);
      const consign = await consignOf(profileId, infos.map((i) => i.mint));
      const listed = await listedOf(infos.map((i) => i.mint));
      return infos.map((info) => {
        const r = evaluateAssetReadiness(info, { seller: wallet });
        return withListing({ mint: info.mint, name: info.name, imageUrl: info.imageUrl, grade: null, standard: info.standard, eligible: r.eligible, reasons: r.reasons, consign: consign.get(info.mint) ?? 'none' }, listed.get(info.mint));
      });
    }
    // `owner_wallet` says where a replica was minted to; a card won in a settled sale (the house room too) is moved on chain only, so the buyer's won cards are added here.
    const won = (await deps.db.select({ m: settlements.mintAddress }).from(settlements).where(and(eq(settlements.buyerId, profileId), eq(settlements.status, 'settled'), isNotNull(settlements.mintAddress))).orderBy(desc(settlements.settledAt)).limit(MAX_CARDS)).map((r) => r.m!);
    const rows = await deps.db.select().from(devnetAssets).where(or(eq(devnetAssets.ownerWallet, wallet), inArray(devnetAssets.mint, won))).orderBy(desc(devnetAssets.mintedAt)).limit(MAX_CARDS);
    const chain = deps.chainFor(cluster);
    const infos: (AssetInfo | null)[] = [];
    for (let i = 0; i < rows.length; i += READ_PARALLEL) infos.push(...(await Promise.all(rows.slice(i, i + READ_PARALLEL).map((r) => chain.readAsset(r.mint)))));
    const consign = await consignOf(profileId, rows.map((r) => r.mint));
    const listed = await listedOf(rows.map((r) => r.mint));
    return rows.map((row, i) => {
      const info = infos[i] ?? null, r = evaluateAssetReadiness(info, { seller: wallet });
      const t = normalizeTraits(row.attributes), trait = (k: string) => t.find((x) => x.trait_type === k)?.value;
      const grade = trait('Grade') === undefined ? null : [trait('Grading Company'), trait('Grade')].filter((x) => x !== undefined).join(' ');
      return withListing({ mint: row.mint, name: row.name, imageUrl: row.imageUrl, grade, standard: info?.standard ?? 'unknown', eligible: r.eligible, reasons: r.reasons, consign: consign.get(row.mint) ?? 'none' }, listed.get(row.mint));
    });
  }

  return { listAssets };
}

let override: SellService | undefined;
let instance: SellService | undefined;
export function setSellService(s?: SellService): void {
  override = s;
}
export function getSellService(): SellService {
  if (override) return override;
  return (instance ??= {
    listAssets: async (i) => createSellService({ db: (await import('@/db')).db, chainFor: (c) => createRpcPort(c) }).listAssets(i),
  });
}
