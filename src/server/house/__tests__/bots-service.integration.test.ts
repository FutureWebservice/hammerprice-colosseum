/**
 * House bidders on a real Postgres 18 with the real engine: a bot bids through the normal `placeBid` path (via 'house') with its own real
 * signature, only on the house show, never against a person, never above 60% of the card's value, and never breaks the snapshot.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { verifySigned } from '@/lib/auth/ed25519';
import { LiveSnapshot } from '@/contracts';
import type { LiveSnapshot as Snapshot } from '@/contracts';
import { startEnv, USDC, type Env } from '@/server/auction/__tests__/harness';

let env: Env | undefined; let skipReason: string | undefined;
let S: typeof import('../bots-service');
let R: typeof import('../rollover');
const sa = Keypair.generate();
let keys: Keypair[];

beforeAll(async () => {
  const r = await startEnv();
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  env = r.env;
  S = await import('../bots-service');
  R = await import('../rollover');
  keys = R.deriveBotKeys(sa);
}, 180_000);
afterAll(async () => { await env?.stop(); });
beforeEach(() => { S?.clearBotCaches(); });

const t = (name: string, fn: (e: Env) => Promise<void>, timeout = 60_000) => it(name, async (ctx) => { if (!env) return ctx.skip(skipReason); await fn(env); }, timeout);
const over = (e: Partial<Parameters<typeof S.maybeHouseBid>[1]> = {}) => ({ enabled: () => true, botKeys: () => keys, ...e });

/**
 * A live house show: lot 1 open for 10 s already (40 s lots), card value 120 USDC (opening 60, increment 6, reserve = opening),
 * paddles 1..3 for the house bidders and 4 for a person. `house: false` makes it an ordinary show.
 */
async function room(e: Env, o: { house?: boolean; openedAgoS?: number } = {}) {
  const seller = await e.profile();
  const s = await e.show({
    sellerId: seller.id, status: 'live', isHouse: o.house ?? true, rules: { lotDurationS: 40, gapS: 6 },
    lots: [{ state: 'open', opening: 60n * USDC, increment: 6n * USDC, reserve: 60n * USDC, openedAt: new Date(Date.now() - (o.openedAgoS ?? 10) * 1000), closesAt: new Date(Date.now() + (40 - (o.openedAgoS ?? 10)) * 1000) }],
  });
  await e.pool.query(`update lots set insured_value = $2 where id = $1`, [s.lots[0], (120n * USDC).toString()]);
  const bots: { profileId: string; wallet: string; paddle: number }[] = [];
  for (const k of keys) {
    const wallet = k.publicKey.toBase58();
    const known = (await e.pool.query(`select id from profiles where wallet_address = $1`, [wallet])).rows[0];
    const p = known ? { id: known.id as string, wallet } : await e.profile({ wallet, bot: true });
    const pad = await e.svc.registerPaddle({ showId: s.id, profileId: p.id, sessionPubkey: k.publicKey.toBase58(), maxBid: null, validUntil: new Date(Date.now() + 7_200_000), authMessage: 'a', authSignature: 'b' });
    bots.push({ profileId: p.id, wallet: p.wallet, paddle: pad.number });
  }
  const person = await e.profile();
  const personPaddle = await e.paddle(s.id, person.id);
  return { showId: s.id, lotId: s.lots[0], bots, person, personPaddle };
}
const snap = async (e: Env, id: string) => (await e.svc.getLiveSnapshot(id))!;
/** The same snapshot, `ms` later on the server clock (the room is polled once a second; this skips the waiting). */
const later = (s: Snapshot, ms: number): Snapshot => ({ ...s, serverNow: s.serverNow + ms });

describe('a house bid', () => {
  t('is placed after the quiet gap through the normal engine path, signed by the bot key, via house, in the bid log', async (e) => {
    const a = await room(e);
    const before = await snap(e, a.showId);
    const out = await S.maybeHouseBid(before, over());
    expect(out).not.toBeNull();
    expect(LiveSnapshot.parse(out).lots[0]).toMatchObject({ highBid: String(60n * USDC), bidCount: 1 });
    const { rows: [b] } = await e.pool.query(`select b.via, b.message, b.signature, b.nonce, b.funded_amount::text f, p.wallet_address, p.is_bot, pd.number from bids b join profiles p on p.id = b.bidder_id join paddles pd on pd.id = b.paddle_id where b.lot_id = $1`, [a.lotId]);
    expect(b).toMatchObject({ via: 'house', is_bot: true });
    expect([1, 2, 3]).toContain(b.number);
    expect(verifySigned(b.message, b.signature, b.wallet_address)).toBe(true); // a real signature, verifiable on /verify like any other bid
    expect(b.message).toContain(`lot: ${a.lotId}`);
    expect(b.message).toContain(`amount: ${60n * USDC}`);
    expect(JSON.stringify(out)).not.toContain(b.wallet_address); // paddle numbers, never wallets
  });

  t('waits out the pacing gap: no bid right after the lot opens', async (e) => {
    const a = await room(e, { openedAgoS: 1 });
    expect(await S.maybeHouseBid(await snap(e, a.showId), over())).toBeNull();
    expect((await e.pool.query(`select count(*)::int c from bids where lot_id = $1`, [a.lotId])).rows[0].c).toBe(0);
  });

  t('climbs one increment at a time, a different house bidder each time, and stops at 60% of the value', async (e) => {
    const a = await room(e);
    let s = await snap(e, a.showId);
    const amounts: bigint[] = []; const who: number[] = [];
    for (let step = 0; step < 8; step++) {
      await e.pool.query(`update lots set closes_at = now() + interval '30 seconds' where id = $1`, [a.lotId]); // the lot is always 10 s old when the bots look
      s = later(await snap(e, a.showId), 9_000);
      S.clearBotCaches();
      const out = await S.maybeHouseBid(s, over());
      if (!out) break;
      amounts.push(BigInt(out.lots[0].highBid!));
      who.push(out.lots[0].highBidder!.paddle!);
    }
    expect(amounts.map((x) => x / USDC)).toEqual([60n, 66n, 72n]); // 60% of 120 is 72; a fourth bid would be 78
    expect(who[0]).not.toBe(who[1]); expect(who[1]).not.toBe(who[2]);
    expect(who.every((p) => p >= 1 && p <= 3)).toBe(true);
    expect(amounts.every((x) => x <= (120n * USDC * 60n) / 100n)).toBe(true);
  });

  t('never against a person: once one is the high bidder the bots stop, and a person who tops them keeps the lot', async (e) => {
    const a = await room(e);
    await S.maybeHouseBid(await snap(e, a.showId), over()); // a house bid at 60
    const personBid = await e.bid(a.lotId, a.person, 66n * USDC, { paddleId: a.personPaddle.id });
    expect(personBid.ok).toBe(true);
    for (const ms of [5_000, 10_000, 20_000, 60_000]) {
      S.clearBotCaches();
      expect(await S.maybeHouseBid(later(await snap(e, a.showId), ms), over())).toBeNull();
    }
    const lot = await e.lot(a.lotId);
    expect(lot.high_bidder_id).toBe(a.person.id);
    expect(BigInt(lot.high_bid)).toBe(66n * USDC);
    expect((await e.pool.query(`select count(*)::int c from bids b join profiles p on p.id = b.bidder_id where b.lot_id = $1 and p.is_bot`, [a.lotId])).rows[0].c).toBe(1);
  });

  t('a person who bid earlier still stops the bots even if a house bid is now on top (checked in the database right before bidding)', async (e) => {
    const a = await room(e);
    await e.pool.query(`insert into bids (lot_id, bidder_id, amount, signature, message, nonce) values ($1, $2, 55000000, 's', 'm', 'old')`, [a.lotId, a.person.id]);
    await e.pool.query(`update lots set high_bid = 60000000, high_bidder_id = $2, bid_count = 2 where id = $1`, [a.lotId, a.bots[0].profileId]);
    const s = later(await snap(e, a.showId), 20_000);
    expect(s.lots[0].highBidder!.paddle).toBe(a.bots[0].paddle);
    expect(await S.maybeHouseBid(s, over())).toBeNull();
    expect((await e.pool.query(`select count(*)::int c from bids where lot_id = $1 and via = 'house'`, [a.lotId])).rows[0].c).toBe(0);
  });

  t('only on the house show: an ordinary show is never touched, and the engine itself refuses a house bid there', async (e) => {
    const a = await room(e, { house: false });
    expect(await S.maybeHouseBid(await snap(e, a.showId), over())).toBeNull();
    const r = await e.svc.placeBid({ lotId: a.lotId, amount: 60n * USDC, bidderProfileId: a.bots[0].profileId, bidderWallet: a.bots[0].wallet, paddleId: null, via: 'house', message: 'm', signature: 's', nonce: 'x', fundsBalance: 10n ** 15n });
    expect(r).toMatchObject({ ok: false, code: 'forbidden' });
  });

  t('is off unless HOUSE_BOTS_ENABLED is true, and the house_bots kill switch turns it off at once', async (e) => {
    const a = await room(e);
    const s = await snap(e, a.showId);
    vi.stubEnv('HOUSE_BOTS_ENABLED', 'false');
    expect(await S.maybeHouseBid(s)).toBeNull(); // the default enabled() reads the environment
    vi.stubEnv('HOUSE_BOTS_ENABLED', 'true');
    const { clearFlagMemo } = await import('@/app/api/auctions/_shared/flags');
    await e.pool.query(`insert into app_flags (key, value) values ('house_bots', 'false'::jsonb) on conflict (key) do update set value = 'false'::jsonb`);
    clearFlagMemo();
    expect(await S.maybeHouseBid(s, { botKeys: () => keys })).toBeNull();
    await e.pool.query(`delete from app_flags where key = 'house_bots'`);
    clearFlagMemo();
    expect(await S.maybeHouseBid(s, { botKeys: () => keys })).not.toBeNull();
    vi.unstubAllEnvs();
  });

  t('never breaks the snapshot: a failing engine, missing keys or a missing paddle all answer null', async (e) => {
    const a = await room(e);
    const s = await snap(e, a.showId);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await S.maybeHouseBid(s, over({ auction: { placeBid: async () => { throw new Error('boom'); } } }))).toBeNull();
    S.clearBotCaches();
    expect(await S.maybeHouseBid(s, over({ botKeys: () => null }))).toBeNull();
    S.clearBotCaches();
    expect(await S.maybeHouseBid(s, over({ botKeys: () => [Keypair.generate(), Keypair.generate(), Keypair.generate()] }))).toBeNull(); // not this show's bidders
    warn.mockRestore();
    expect((await e.pool.query(`select count(*)::int c from bids where lot_id = $1`, [a.lotId])).rows[0].c).toBe(0);
  });

  t('the live snapshot route runs the bots on a house show and answers the post-bid snapshot, with the CDN header intact', async (e) => {
    const a = await room(e);
    vi.stubEnv('HOUSE_BOTS_ENABLED', 'true');
    vi.stubEnv('SETTLEMENT_AUTHORITY_SECRET_KEY', JSON.stringify([...sa.secretKey]));
    const { GET } = await import('@/app/api/auctions/[id]/live/route');
    const res = await GET(new Request(`http://localhost:3000/api/auctions/${a.showId}/live`), { params: Promise.resolve({ id: a.showId }) });
    expect(res.headers.get('vercel-cdn-cache-control')).toBe('max-age=1');
    const body = LiveSnapshot.parse(await res.json());
    expect(body.lots[0]).toMatchObject({ highBid: String(60n * USDC), bidCount: 1 });
    expect([1, 2, 3]).toContain(body.lots[0].highBidder!.paddle);
    vi.unstubAllEnvs();
  });
});
