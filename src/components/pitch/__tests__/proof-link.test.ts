/**
 * The live proof link of the About page against a real Postgres (embedded): the newest REVEALED lot order of a HOUSE show, nothing else.
 * (The other pitch tests need no database; this one skips itself where the embedded Postgres cannot start, for example as root.)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startEnv, type Env } from '@/server/auction/__tests__/harness';

let env: Env | undefined; let skipReason: string | undefined;
let houseProofHref: typeof import('../proof-link').houseProofHref;

beforeAll(async () => {
  const r = await startEnv();
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  env = r.env;
  ({ houseProofHref } = await import('../proof-link'));
}, 180_000);
afterAll(async () => { await env?.stop(); });
beforeEach(async () => {
  if (!env) return;
  await env.pool.query(`delete from vrf_requests; delete from lots; delete from shows`);
});

const t = (name: string, fn: (e: Env) => Promise<void>) => it(name, async (ctx) => { if (!env) return ctx.skip(skipReason); await fn(env); }, 60_000);

async function draw(e: Env, showId: string, over: { status?: string; purpose?: string; revealedAt?: string } = {}) {
  const { rows } = await e.pool.query(
    `insert into vrf_requests (purpose, subject_type, subject_id, cluster, public_key, params, params_hash, status, reveal_by, revealed_at)
     values ($1,'show',$2,'devnet','pk','{}'::jsonb,'hash',$3, now() + interval '1 hour', $4::timestamptz) returning id`,
    [over.purpose ?? 'lot_order', showId, over.status ?? 'revealed', over.revealedAt ?? new Date().toISOString()],
  );
  return rows[0].id as string;
}

describe('houseProofHref', () => {
  t('is null when no lot order has been drawn', async () => {
    expect(await houseProofHref()).toBeNull();
  });

  t('ignores a draw that is not revealed, not a lot order, or not of a house show', async (e) => {
    const seller = await e.profile();
    const house = await e.show({ sellerId: seller.id, isHouse: true, lots: [{}] });
    const other = await e.show({ sellerId: seller.id, isHouse: false, lots: [{}] });
    await draw(e, house.id, { status: 'committed' });
    await draw(e, house.id, { purpose: 'raffle' });
    await draw(e, other.id);
    expect(await houseProofHref()).toBeNull();
  });

  t('points at the newest revealed lot order of a house show, in the route the room link uses', async (e) => {
    const seller = await e.profile();
    const first = await e.show({ sellerId: seller.id, isHouse: true, status: 'ended', lots: [{}] });
    const second = await e.show({ sellerId: seller.id, isHouse: true, lots: [{}] });
    await draw(e, first.id, { revealedAt: '2026-10-01T10:00:00Z' });
    const newest = await draw(e, second.id, { revealedAt: '2026-10-02T10:00:00Z' });
    expect(await houseProofHref()).toBe(`/verify/random/${newest}`);
  });
});
