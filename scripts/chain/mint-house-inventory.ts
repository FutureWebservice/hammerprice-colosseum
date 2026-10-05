/**
 * Mints house replica cards into the "Hammerprice Devnet Vault" collection: real vault photos, grades and names copied from the
 * public Collector Crypt catalogue, labelled as devnet replicas (attributes.replica_of = the real CC mint). Payer = SA, owner =
 * HOUSE_SELLER. Each card is recorded in the devnet_assets table of the database in the environment (the staging branch).
 * Idempotent: a card already replicated (same replica_of) is skipped.
 *
 *   npx tsx scripts/chain/mint-house-inventory.ts [--count 8]
 *
 * Needs the keys file (see src/lib/chain/replica-mint.ts) and SA funded with devnet SOL; when it is not, it stops and says how much to send where.
 * Devnet only; never prints a secret.
 */
import { Connection } from '@solana/web3.js';
import { normalizeTraits } from '@/lib/chain/devnet-cards';
import { eq } from 'drizzle-orm';
import { addressesFor, connectionIo, devnetUrl, FundingError, loadRoleKeys, mintReplica, neededLamports, requireFunds, type Io, type ReplicaSource, type RoleKeys } from '@/lib/chain/replica-mint';
import { assertNotProductionDb, loadScriptEnv } from './env';

/** The real catalogue to copy from: Core cards with a photo and a grade, deduplicated. */
export async function pickSources(count: number, skip: Set<string>): Promise<ReplicaSource[]> {
  const { listCards } = await import('@/lib/vault/collector-crypt');
  const out: ReplicaSource[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10 && out.length < count; page++) {
    const r = await listCards({ step: 60, cursor });
    for (const c of r.cards) {
      if (out.length >= count) break;
      if (c.nftStandard !== 'core' || !c.images.front || !c.grade || skip.has(c.nftAddress)) continue;
      out.push({ replicaOf: c.nftAddress, name: c.name, imageUrl: c.images.front, grade: c.grade, gradingCompany: c.gradingCompany, gradingId: c.gradingId, vault: c.vault, set: c.set, category: c.category, insuredValueUsd: c.insuredValue });
    }
    if (!r.nextCursor) break;
    cursor = r.nextCursor;
  }
  return out;
}

export async function mintHouseInventory(io: Io, k: RoleKeys, count: number, log: (s: string) => void = console.log): Promise<number> {
  assertNotProductionDb();
  const { db, devnetAssets } = await import('@/db');
  const house = k.house.publicKey.toBase58();
  const existing = await db.select().from(devnetAssets).where(eq(devnetAssets.ownerWallet, house));
  const have = new Set(existing.map((r) => String(normalizeTraits(r.attributes).find((t) => t.trait_type === 'Replica of')?.value))); // either stored shape
  const want = Math.max(0, count - have.size);
  if (want === 0) { log(`house inventory already holds ${have.size} replica(s), nothing to mint`); return 0; }
  const sources = await pickSources(want, have);
  const collection = addressesFor(k.sa).collection;
  let n = 0;
  for (const s of sources) {
    const r = await mintReplica(io, k, collection, s);
    await db.insert(devnetAssets).values({ mint: r.mint.toBase58(), ownerWallet: house, name: r.name, imageUrl: s.imageUrl, attributes: normalizeTraits(r.attributes) }).onConflictDoNothing();
    log(`minted ${r.mint.toBase58()}  ${r.name}`);
    n++;
  }
  return n;
}

async function main() {
  loadScriptEnv();
  const i = process.argv.indexOf('--count');
  const count = i >= 0 ? Number(process.argv[i + 1]) : 8;
  if (!Number.isInteger(count) || count < 1 || count > 60) throw new Error('--count must be an integer from 1 to 60');
  const k = loadRoleKeys();
  const conn = new Connection(devnetUrl(), 'confirmed');
  const io = connectionIo(conn);
  try { await requireFunds(io, k.sa.publicKey, await neededLamports(io, k, { cards: count }), conn); } catch (e) { if (e instanceof FundingError) { console.error(e.message); process.exit(2); } throw e; }
  await mintHouseInventory(io, k, count);
  process.exit(0);
}

if (process.argv[1]?.endsWith('mint-house-inventory.ts')) main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
