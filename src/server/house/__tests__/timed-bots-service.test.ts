/** The house bidder service on a timed show (real Postgres and engine): it reads the show's kind from the snapshot and paces by the time left. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { LiveSnapshot } from '@/contracts';
import type { LiveSnapshot as Snapshot } from '@/contracts';
import { startEnv, USDC, type Env } from '@/server/auction/__tests__/harness';

let env: Env | undefined; let skipReason: string | undefined;
let S: typeof import('../bots-service');
let R: typeof import('../rollover');
let keys: Keypair[];
beforeAll(async () => {
  const r = await startEnv();
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  env = r.env;
  S = await import('../bots-service');
  R = await import('../rollover');
  keys = R.deriveBotKeys(Keypair.generate());
}, 180_000);
afterAll(async () => { await env?.stop(); });
beforeEach(() => { S?.clearBotCaches(); });
const t = (name: string, fn: (e: Env) => Promise<void>, timeout = 60_000) => it(name, async (ctx) => { if (!env) return ctx.skip(skipReason); await fn(env); }, timeout);
const over = () => ({ enabled: () => true, botKeys: () => keys });
const later = (s: Snapshot, ms: number): Snapshot => ({ ...s, serverNow: s.serverNow + ms });

/** A house show whose only lot opened just now and runs for `durationS`; `kind` timed or live. */
async function room(e: Env, kind: 'timed' | 'live', durationS: number) {
  const seller = await e.profile();
  const s = await e.show({
    sellerId: seller.id, status: 'live', isHouse: true, rules: { lotDurationS: durationS },
    lots: [{ state: 'open', opening: 60n * USDC, increment: 6n * USDC, reserve: 60n * USDC, openedAt: new Date(), closesAt: new Date(Date.now() + durationS * 1000) }],
  });
  await e.pool.query(`update shows set kind = $2 where id = $1`, [s.id, kind]);
  await e.pool.query(`update lots set insured_value = $2 where id = $1`, [s.lots[0], (1000n * USDC).toString()]);
  for (const k of keys) {
    const wallet = k.publicKey.toBase58();
    const known = (await e.pool.query(`select id from profiles where wallet_address = $1`, [wallet])).rows[0];
    const p = known ? { id: known.id as string } : await e.profile({ wallet, bot: true });
    await e.svc.registerPaddle({ showId: s.id, profileId: p.id, sessionPubkey: wallet, maxBid: null, validUntil: new Date(Date.now() + 86_400_000 * 3), authMessage: 'a', authSignature: 'b' });
  }
  return { showId: s.id, lotId: s.lots[0] };
}

describe('house bids on a timed show', () => {
  t('wait for minutes, not seconds: nothing 2 minutes after the open, a bid by 13 minutes (a one hour lot)', async (e) => {
    const a = await room(e, 'timed', 3600);
    const snap = (await e.svc.getLiveSnapshot(a.showId))!;
    expect(snap.show.kind).toBe('timed');
    expect(await S.maybeHouseBid(later(snap, 2 * 60_000), over())).toBeNull(); // a live lot would have bid long ago
    expect((await e.pool.query(`select count(*)::int c from bids where lot_id = $1`, [a.lotId])).rows[0].c).toBe(0);
    S.clearBotCaches();
    const out = await S.maybeHouseBid(later(snap, 13 * 60_000), over());
    expect(out).not.toBeNull();
    expect(LiveSnapshot.parse(out).lots[0]).toMatchObject({ highBid: String(60n * USDC), bidCount: 1 });
  });

  t('the same snapshot on a live show bids within seconds (unchanged)', async (e) => {
    const a = await room(e, 'live', 60);
    const snap = (await e.svc.getLiveSnapshot(a.showId))!;
    expect(snap.show.kind).toBe('live');
    expect(await S.maybeHouseBid(later(snap, 9_000), over())).not.toBeNull();
  });
});
