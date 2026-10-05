/**
 * The parts of the house room that spend or gate something, tested without a database: the restock mint is fenced (SOL floor, devnet only,
 * configured, a template to copy), and the schedule read keeps the house room alive without ever depending on it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';

const sa = Keypair.generate(); const house = Keypair.generate(); const faucet = Keypair.generate(); const fee = Keypair.generate().publicKey.toBase58();
const lamports = { value: 2_000_000_000n };
const mintReplica = vi.fn();
vi.mock('@/lib/chain/replica-mint', () => ({
  connectionIo: () => ({ getBalance: async () => lamports.value }),
  addressesFor: () => ({ collection: Keypair.generate().publicKey }),
  mintReplica: (...a: unknown[]) => mintReplica(...a),
}));

const replica = (mint: string, replicaOf: string, over: Record<string, unknown> = {}) => ({
  mint, ownerWallet: house.publicKey.toBase58(), name: `Card ${replicaOf} (devnet replica)`, imageUrl: 'https://img.example/x.png', mintedAt: new Date(),
  attributes: { replica: 'true', replica_of: replicaOf, grade: 'MINT 9', grading_company: 'PSA', set: 'Base', grading_id: '77', vault: 'PWCC', category: 'Pokemon', insured_value_usd: '80', ...over },
});
/** Just enough of drizzle's builder for the one select and the one insert the mint does. */
const fakeDb = (rows: unknown[]) => {
  const inserted: unknown[] = [];
  return { inserted, db: { select: () => ({ from: () => ({ where: async () => rows }) }), insert: () => ({ values: (v: unknown) => { inserted.push(v); return { onConflictDoNothing: async () => undefined }; } }) } as never };
};

beforeEach(() => {
  mintReplica.mockReset();
  mintReplica.mockImplementation(async () => ({ mint: Keypair.generate().publicKey, name: 'New (devnet replica)', attributes: { replica: 'true' }, signature: 'sig' }));
  lamports.value = 2_000_000_000n;
  vi.stubEnv('SOLANA_CLUSTER', 'devnet');
  vi.stubEnv('NEXT_PUBLIC_SOLANA_NETWORK', 'devnet');
  vi.stubEnv('SETTLEMENT_AUTHORITY_SECRET_KEY', JSON.stringify([...sa.secretKey]));
  vi.stubEnv('HOUSE_SELLER_SECRET_KEY', JSON.stringify([...house.secretKey]));
  vi.stubEnv('FAUCET_MINT_AUTHORITY_SECRET_KEY', JSON.stringify([...faucet.secretKey]));
  vi.stubEnv('PLATFORM_WALLET_ADDRESS', fee);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('mintOneReplica (the restock)', () => {
  it('refuses below 0.5 SOL on the settlement authority, and does not touch the chain helper', async () => {
    const { mintOneReplica, MIN_SA_LAMPORTS } = await import('../rollover');
    expect(MIN_SA_LAMPORTS).toBe(500_000_000n);
    lamports.value = 499_999_999n;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { db, inserted } = fakeDb([replica('m1', 'r1')]);
    expect(await mintOneReplica(db)).toBe(false);
    expect(mintReplica).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });

  it('with enough SOL copies the least-duplicated template once and records the new card for the house', async () => {
    const { mintOneReplica } = await import('../rollover');
    lamports.value = 500_000_000n; // exactly the floor is enough
    const { db, inserted } = fakeDb([replica('a1', 'A'), replica('a2', 'A'), replica('b1', 'B'), replica('c1', 'C'), replica('c2', 'C')]);
    expect(await mintOneReplica(db)).toBe(true);
    expect(mintReplica).toHaveBeenCalledTimes(1); // one card per call, never a loop
    const [, keys, , source] = mintReplica.mock.calls[0] as [unknown, { house: Keypair }, unknown, Record<string, unknown>];
    expect(keys.house.publicKey.toBase58()).toBe(house.publicKey.toBase58());
    expect(source).toMatchObject({ replicaOf: 'B', name: 'Card B', grade: 'MINT 9', gradingCompany: 'PSA', set: 'Base', insuredValueUsd: 80 }); // B has one copy, A and C two
    expect(inserted).toEqual([expect.objectContaining({ ownerWallet: house.publicKey.toBase58(), name: 'New (devnet replica)' })]);
  });

  it('does nothing off devnet, without a fee wallet or with nothing to copy', async () => {
    const { mintOneReplica } = await import('../rollover');
    const { db } = fakeDb([replica('a1', 'A')]);
    vi.stubEnv('SOLANA_CLUSTER', 'mainnet-beta'); vi.stubEnv('NEXT_PUBLIC_SOLANA_NETWORK', 'mainnet-beta');
    expect(await mintOneReplica(db)).toBe(false);
    vi.stubEnv('SOLANA_CLUSTER', 'devnet'); vi.stubEnv('NEXT_PUBLIC_SOLANA_NETWORK', 'devnet');
    vi.stubEnv('PLATFORM_WALLET_ADDRESS', '');
    expect(await mintOneReplica(db)).toBe(false);
    vi.stubEnv('PLATFORM_WALLET_ADDRESS', fee);
    expect(await mintOneReplica(fakeDb([]).db)).toBe(false);
    expect(await mintOneReplica(fakeDb([replica('x', '')]).db)).toBe(false); // a row with no replica_of is not a template
    expect(mintReplica).not.toHaveBeenCalled();
  });
});

describe('GET /api/shows keeps the house room alive', () => {
  it('asks for a rollover unless the list is the ended archive, and a rollover that fails never fails the read', async () => {
    vi.resetModules();
    const keep = vi.fn(async () => 'none');
    vi.doMock('@/server/house/rollover', () => ({ keepHouseShowAlive: keep }));
    const { setLiveServices } = await import('@/app/api/auctions/_shared/deps');
    const listShows = vi.fn(async () => ({ shows: [], nextCursor: null }));
    setLiveServices({ auction: { listShows } as never });
    const { GET } = await import('@/app/api/shows/route');
    const call = (q: string) => GET(new Request(`http://localhost:3000/api/shows${q}`));
    expect((await call('')).status).toBe(200);
    expect((await call('?status=live')).status).toBe(200);
    expect((await call('?status=scheduled')).status).toBe(200);
    expect(keep).toHaveBeenCalledTimes(1); // the three lists share one check (sweep.ts): the schedule page asks for four at once
    expect((await call('?status=ended')).status).toBe(200);
    expect(keep).toHaveBeenCalledTimes(1); // the archive does not need a live room
    expect(listShows).toHaveBeenCalledTimes(4);
    vi.doUnmock('@/server/house/rollover');
  });
});
