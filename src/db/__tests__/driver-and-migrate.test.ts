/**
 * The piece that stands between the schema and the databases: src/db/index.ts (which driver a URL gets). Runs on the embedded
 * Postgres with every migration in drizzle/ applied.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { isLocalDatabaseUrl } from '../url';
import { startTestPg, type TestPg } from './pg-harness';


describe('isLocalDatabaseUrl', () => {
  it.each([
    ['postgresql://u:p@localhost:5432/db', true],
    ['postgresql://u:p@127.0.0.1:54329/hp', true],
    ['postgresql://u:p@[::1]:5432/db', true],
    ['postgresql://u:p@pg.localhost/db', true],
    ['postgresql://u:p@ep-staging-example-pooler.c-12.us-east-1.aws.neon.tech/neondb?sslmode=require', false],
    ['postgresql://u:p@localhost.evil.example/db', false],
  ])('%s -> %s', (url, local) => expect(isLocalDatabaseUrl(url)).toBe(local));
});

let t: TestPg | undefined;
let skipReason: string | undefined;
beforeAll(async () => {
  const r = await startTestPg({ poolMax: 4 });
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  t = r.pg;
}, 120_000);
afterAll(async () => { await t?.stop(); });

describe('against a real Postgres with every migration', () => {
  it('the settlements row carries the co-sign round and no delegate columns exist anywhere', async (ctx) => {
    if (!t) return ctx.skip(skipReason);
    const cols = (await t.pool.query(`select column_name, is_nullable, column_default from information_schema.columns where table_name='settlements'`)).rows;
    const by = Object.fromEntries(cols.map((c) => [c.column_name, c]));
    for (const c of ['rail', 'status', 'attempt', 'prepared_message', 'prepared_blockhash', 'last_valid_height', 'round_expires_at', 'buyer_signature', 'seller_signature', 'due_at', 'tx_signature', 'failure_code', 'failure_detail', 'bid_log_hash', 'memo']) expect(by, c).toHaveProperty(c);
    expect(by.rail.column_default).toContain('cosign');
    expect(by.status.column_default).toContain('awaiting_payment');
    expect(by.tx_signature.is_nullable).toBe('YES');
    const delegate = (await t.pool.query(`select table_name, column_name from information_schema.columns where table_schema='public' and column_name like '%delegate%'`)).rows;
    expect(delegate).toEqual([]);
  });

  it('src/db/index.ts uses node-postgres on localhost: bigint, jsonb, FOR UPDATE and rollback work through drizzle', async (ctx) => {
    if (!t) return ctx.skip(skipReason);
    const g = globalThis as unknown as { __pool?: { end(): Promise<void> } };
    const prev = process.env.DATABASE_URL; process.env.DATABASE_URL = t.url; delete g.__pool;
    try {
      const { db, profiles, shows, lots, settlements } = await import('../index');
      const { eq } = await import('drizzle-orm');
      expect(g.__pool).toBeInstanceOf(pg.Pool);
      const [seller] = await db.insert(profiles).values({ walletAddress: 'DRIVER_SELLER', isSeller: true }).returning();
      const [show] = await db.insert(shows).values({ sellerId: seller.id, title: 'driver', rules: { lotDurationS: 45 }, cluster: 'devnet' }).returning();
      expect([show.mode, show.settlementMode, show.isHouse]).toEqual(['auto', 'none', false]);
      expect(show.rules).toEqual({ lotDurationS: 45 });
      const big = 12_345_678_901n;
      const [lot] = await db.insert(lots).values({ showId: show.id, sellerId: seller.id, lotNumber: 1, mintAddress: 'M', nftStandard: 'core', name: 'L', increment: 100n, openingPrice: big }).returning();
      expect(lot.openingPrice).toBe(big);
      expect([lot.consignStatus, lot.bidCount, lot.closesAt]).toEqual(['none', 0, null]);

      await db.transaction(async (tx) => {
        const [locked] = await tx.select().from(lots).where(eq(lots.id, lot.id)).for('update');
        await tx.insert(settlements).values({ lotId: lot.id, buyerId: seller.id, sellerId: seller.id, grossAmount: big, platformFee: 1n, sellerAmount: 2n, lastValidHeight: 987_654_321, memo: 'hp:settle:x:y' });
        expect(locked.id).toBe(lot.id);
      });
      const [s] = await db.select().from(settlements).where(eq(settlements.lotId, lot.id));
      expect([s.status, s.rail, s.attempt, s.royaltyAmount, s.lastValidHeight, s.buyerSignature, s.txSignature]).toEqual(['awaiting_payment', 'cosign', 1, 0n, 987_654_321, null, null]);

      await expect(db.transaction(async (tx) => {
        await tx.update(lots).set({ state: 'open', openedAt: new Date(), closesAt: new Date(Date.now() + 60_000) }).where(eq(lots.id, lot.id));
        throw new Error('boom');
      })).rejects.toThrow('boom');
      expect((await db.select().from(lots).where(eq(lots.id, lot.id)))[0].state).toBe('catalogued');
    } finally {
      await (g as { __pool?: { end(): Promise<void> } }).__pool?.end(); delete g.__pool;
      if (prev === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prev;
    }
  });
});

describe('src/db/index.ts on a Neon URL', () => {
  it('builds the WebSocket pool (no connection is made until a query runs)', async () => {
    const g = globalThis as unknown as { __pool?: { end(): Promise<void> } };
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://u:p@ep-test-000000-pooler.c-12.us-east-1.aws.neon.tech/neondb?sslmode=require';
    delete g.__pool;
    try {
      vi.resetModules();
      await import('../index');
      expect(g.__pool).toBeDefined();
      expect(g.__pool).not.toBeInstanceOf(pg.Pool);
    } finally {
      await (g as { __pool?: { end(): Promise<void> } }).__pool?.end().catch(() => {}); delete g.__pool;
      if (prev === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prev;
    }
  });
});
