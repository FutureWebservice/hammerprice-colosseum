/** createShow, seller controls, paddles, catalogue and lists: the real service on Postgres 18. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '@/contracts/errors';
import { ShowDetail, ShowListResponse, LiveSnapshot, CatalogueLot } from '@/contracts/api';
import { startEnv, USDC, type Env } from './harness';
import { DEMO_SHOW_ID, SEED_SELLER_WALLET } from '@/lib/demo-show';

let env: Env | undefined; let skipReason: string | undefined;
beforeAll(async () => { const r = await startEnv(); if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); } else env = r.env; }, 180_000);
afterAll(async () => { await env?.stop(); });
// one card, one place: a card of an earlier test is released before the next one lists it again
beforeEach(async () => { await env?.pool.query(`update lots set state = 'withdrawn' where state in ('catalogued', 'open')`); });
const t = (name: string, fn: (e: Env) => Promise<void>, timeout = 60_000) => it(name, async (ctx) => { if (!env) return ctx.skip(skipReason); await fn(env); }, timeout);

const ok = { eligible: true, reasons: [] as never[] };
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const mint = (n: number) => `Mint${B58[n % B58.length]}${B58[Math.floor(n / B58.length) % B58.length]}${'x'.repeat(31)}`;
const code = async (p: Promise<unknown>) => { try { await p; return 'no error'; } catch (e) { return e instanceof ApiError ? e.code : `other: ${(e as Error).message}`; } };

describe('createShow', () => {
  t('creates show and lots together with the defaults of the catalogue rules', async (e) => {
    const seller = await e.profile();
    const d = await e.svc.createShow({
      title: 'Sunday slabs', sellerProfileId: seller.id, scheduledAt: '2026-10-05T18:00:00.000Z', rules: { lotDurationS: 30 },
      lots: [{ mint: mint(1), reserve: String(100n * USDC) }, { mint: mint(2), openingPrice: String(10n * USDC), increment: String(2n * USDC), buyNowPrice: String(500n * USDC) }],
      readiness: { [mint(1)]: ok, [mint(2)]: ok },
      assets: { [mint(1)]: { name: 'Charizard ex', grade: '10', gradingCompany: 'PSA', imageUrl: 'https://example.test/c.png', insuredValue: 250n * USDC } },
    });
    ShowDetail.parse(d);
    expect(d.show).toMatchObject({ title: 'Sunday slabs', status: 'scheduled', mode: 'auto', settlementMode: 'onchain', cluster: 'devnet', isHouse: false, scheduledAt: '2026-10-05T18:00:00.000Z', startedAt: null });
    expect(d.lots.map((l) => l.lotNumber)).toEqual([1, 2]);
    // estimate = reserve 100 USDC: opening 50 (half), increment 5 (5%)
    expect(d.lots[0]).toMatchObject({ name: 'Charizard ex', grade: '10', gradingCompany: 'PSA', reserve: String(100n * USDC), openingPrice: String(50n * USDC), increment: String(5n * USDC), insuredValue: String(250n * USDC), consignStatus: 'ready', nftStandard: 'core' });
    expect(d.lots[1]).toMatchObject({ name: 'Graded card', reserve: null, openingPrice: String(10n * USDC), increment: String(2n * USDC), buyNowPrice: String(500n * USDC) });
    const { rows: [s] } = await e.pool.query(`select * from shows where id=$1`, [d.show.id]);
    expect(s.rules).toEqual({ lotDurationS: 30 });
    expect((await e.pool.query(`select is_seller from profiles where id=$1`, [seller.id])).rows[0].is_seller).toBe(true);
  });

  t('replica facts come from devnet_assets when no asset facts are passed', async (e) => {
    const seller = await e.profile();
    await e.pool.query(`insert into devnet_assets (mint, owner_wallet, name, image_url, attributes) values ($1,$2,'Pikachu VMAX',$3,$4)`, [
      mint(7), seller.wallet, 'https://example.test/p.png', JSON.stringify([{ trait_type: 'Grade', value: 9 }, { trait_type: 'Set', value: 'Vivid Voltage' }, { trait_type: 'Grading Company', value: 'BGS' }])]);
    const d = await e.svc.createShow({ title: 'Replica show', sellerProfileId: seller.id, lots: [{ mint: mint(7) }], readiness: { [mint(7)]: ok } });
    expect(d.lots[0]).toMatchObject({ name: 'Pikachu VMAX', imageUrl: 'https://example.test/p.png', grade: '9', setName: 'Vivid Voltage', gradingCompany: 'BGS' });
  });

  t('refuses with the right code before writing anything: readiness, amounts, duplicates, counts', async (e) => {
    const seller = await e.profile();
    const base = { title: 'Refused show', sellerProfileId: seller.id };
    const before = Number((await e.pool.query(`select count(*)::int as n from shows`)).rows[0].n);
    expect(await code(e.svc.createShow({ ...base, lots: [{ mint: mint(1) }], readiness: {} }))).toBe('asset_not_ready');
    expect(await code(e.svc.createShow({ ...base, lots: [{ mint: mint(1) }], readiness: { [mint(1)]: { eligible: false, reasons: ['not_owner'] } } }))).toBe('not_owner');
    expect(await code(e.svc.createShow({ ...base, lots: [{ mint: mint(1) }], readiness: { [mint(1)]: { eligible: false, reasons: ['frozen'] } } }))).toBe('frozen');
    expect(await code(e.svc.createShow({ ...base, lots: [{ mint: mint(1) }], readiness: { [mint(1)]: { eligible: false, reasons: ['unsupported_standard'] } } }))).toBe('unsupported_standard');
    expect(await code(e.svc.createShow({ ...base, lots: [{ mint: mint(1) }], readiness: { [mint(1)]: { eligible: false, reasons: ['royalty_rules_block_transfer'] } } }))).toBe('asset_not_ready');
    const r = { [mint(1)]: ok };
    expect(await code(e.svc.createShow({ ...base, lots: [{ mint: mint(1), reserve: '99999999999999999999' }], readiness: r }))).toBe('validation');
    expect(await code(e.svc.createShow({ ...base, lots: [{ mint: mint(1), increment: '0' }], readiness: r }))).toBe('validation');
    expect(await code(e.svc.createShow({ ...base, lots: [{ mint: mint(1), openingPrice: '-1' }], readiness: r }))).toBe('validation');
    expect(await code(e.svc.createShow({ ...base, lots: [{ mint: mint(1) }, { mint: mint(1) }], readiness: r }))).toBe('validation');
    expect(await code(e.svc.createShow({ ...base, lots: [], readiness: r }))).toBe('validation');
    expect(await code(e.svc.createShow({ ...base, lots: Array.from({ length: 31 }, (_, n) => ({ mint: mint(n) })), readiness: r }))).toBe('validation');
    expect(await code(e.svc.createShow({ ...base, sellerProfileId: 'nope', lots: [{ mint: mint(1) }], readiness: r }))).toBe('forbidden');
    expect(Number((await e.pool.query(`select count(*)::int as n from shows`)).rows[0].n)).toBe(before);
  });

  t('atomic: a failure while inserting the lots leaves no show behind', async (e) => {
    const seller = await e.profile();
    await e.pool.query(`create or replace function hp_test_boom() returns trigger language plpgsql as $$ begin if new.name = 'EXPLODE' then raise exception 'boom'; end if; return new; end $$`);
    await e.pool.query(`create trigger hp_test_boom before insert on lots for each row execute function hp_test_boom()`);
    try {
      const before = Number((await e.pool.query(`select count(*)::int as n from shows`)).rows[0].n);
      const beforeLots = Number((await e.pool.query(`select count(*)::int as n from lots`)).rows[0].n);
      const r = await code(e.svc.createShow({
        title: 'Half made', sellerProfileId: seller.id, lots: [{ mint: mint(1) }, { mint: mint(2) }, { mint: mint(3) }],
        readiness: { [mint(1)]: ok, [mint(2)]: ok, [mint(3)]: ok }, assets: { [mint(2)]: { name: 'EXPLODE' } },
      }));
      expect(r).toMatch(/^other:/);
      expect(Number((await e.pool.query(`select count(*)::int as n from shows`)).rows[0].n)).toBe(before);
      expect(Number((await e.pool.query(`select count(*)::int as n from lots`)).rows[0].n)).toBe(beforeLots);
      expect((await e.pool.query(`select is_seller from profiles where id=$1`, [seller.id])).rows[0].is_seller).toBe(false);
    } finally { await e.pool.query(`drop trigger hp_test_boom on lots`); }
  });

  t('20 concurrent creates: every show has exactly its lots, numbered 1..n, with no partial show visible', async (e) => {
    const sellers = await Promise.all(Array.from({ length: 5 }, () => e.profile()));
    const mk = (n: number) => e.svc.createShow({
      title: `Concurrent ${n}`, sellerProfileId: sellers[n % 5].id, lots: Array.from({ length: 10 }, (_, k) => ({ mint: mint(100 + n * 10 + k) })), // one card, one place: every show has its own cards
      readiness: Object.fromEntries(Array.from({ length: 10 }, (_, k) => [mint(100 + n * 10 + k), ok])),
    });
    const observer = (async () => {
      for (let n = 0; n < 40; n++) {
        const { rows } = await e.pool.query(`select s.id, count(l.id)::int as n from shows s left join lots l on l.show_id = s.id where s.title like 'Concurrent %' group by s.id`);
        for (const r of rows) expect(r.n).toBe(10); // a half-made show would show fewer
      }
    })();
    const made = await Promise.all(Array.from({ length: 20 }, (_, n) => mk(n)));
    await observer;
    for (const d of made) expect(d.lots.map((l) => l.lotNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(new Set(made.map((d) => d.show.id)).size).toBe(20);
  }, 120_000);

  t('a created show runs end to end through the lazy engine', async (e) => {
    const seller = await e.profile(); const bob = await e.profile();
    const d = await e.svc.createShow({ title: 'Run me', sellerProfileId: seller.id, rules: { lotDurationS: 10, gapS: 0 }, lots: [{ mint: mint(1), reserve: '0', openingPrice: String(10n * USDC) }], readiness: { [mint(1)]: ok } });
    const actor = { profileId: seller.id, wallet: seller.wallet };
    expect(await code(e.svc.startShow(d.show.id, { profileId: bob.id, wallet: bob.wallet }))).toBe('not_seller');
    const live = await e.svc.startShow(d.show.id, actor);
    expect(live).toMatchObject({ status: 'live' });
    expect(await code(e.svc.startShow(d.show.id, actor))).toBe('wrong_state');
    const snap = LiveSnapshot.parse(await e.svc.getLiveSnapshot(d.show.id));
    expect(snap.current).toMatchObject({ lotNumber: 1, phase: expect.stringMatching(/open|going_once/) });
    await e.paddle(d.show.id, bob.id);
    const b = await e.bid(d.lots[0].id, bob, 10n * USDC);
    expect(b).toMatchObject({ ok: true, belowReserve: false });
  });
});

describe('controlLot (withdraw and extend only while there is no bid)', () => {
  async function open(e: Env, bids = 0) {
    const seller = await e.profile();
    const s = await e.show({ sellerId: seller.id, rules: { lotDurationS: 60, maxExtensionS: 30 }, lots: [{ state: 'open', openedAt: new Date(), closesAt: new Date(Date.now() + 60_000) }, {}] });
    const p = await e.profile(); await e.paddle(s.id, p.id);
    if (bids) await e.bid(s.lots[0], p, 50n * USDC);
    return { seller, s, p };
  }

  t('withdraw works on a catalogued or open lot without a bid, and emits lot.withdrawn', async (e) => {
    const { seller, s } = await open(e);
    const r = await e.svc.controlLot({ lotId: s.lots[1], actorProfileId: seller.id, action: 'withdraw' });
    CatalogueLot.parse(r.lot); LiveSnapshot.parse(r.live);
    expect(r.live.lots.find((l) => l.id === s.lots[1])).toMatchObject({ state: 'withdrawn' });
    await e.svc.controlLot({ lotId: s.lots[0], actorProfileId: seller.id, action: 'withdraw' });
    expect((await e.lot(s.lots[0])).state).toBe('withdrawn');
    expect((await e.events(s.id)).filter((x) => x.kind === 'lot.withdrawn')).toHaveLength(2);
    expect(await code(e.svc.controlLot({ lotId: s.lots[0], actorProfileId: seller.id, action: 'withdraw' }))).toBe('wrong_state'); // already closed
  });

  t('once there is a bid, withdraw and extend are refused by the service itself', async (e) => {
    const { seller, s } = await open(e, 1);
    expect(await code(e.svc.controlLot({ lotId: s.lots[0], actorProfileId: seller.id, action: 'withdraw' }))).toBe('wrong_state');
    expect(await code(e.svc.controlLot({ lotId: s.lots[0], actorProfileId: seller.id, action: 'extend', seconds: 10 }))).toBe('wrong_state');
    expect((await e.lot(s.lots[0])).state).toBe('open');
  });

  t('only the lot seller may control it', async (e) => {
    const { s, p } = await open(e);
    expect(await code(e.svc.controlLot({ lotId: s.lots[0], actorProfileId: p.id, action: 'withdraw' }))).toBe('not_seller');
    expect(await code(e.svc.controlLot({ lotId: '00000000-0000-4000-8000-000000000000', actorProfileId: p.id, action: 'withdraw' }))).toBe('not_found');
    expect(await code(e.svc.controlLot({ lotId: 'nope', actorProfileId: p.id, action: 'withdraw' }))).toBe('not_found');
  });

  t('extend adds seconds up to the cap, never backwards, and only on an open lot', async (e) => {
    const { seller, s } = await open(e);
    const before = (await e.lot(s.lots[0])).closes_at.getTime();
    await e.svc.controlLot({ lotId: s.lots[0], actorProfileId: seller.id, action: 'extend', seconds: 10 });
    expect((await e.lot(s.lots[0])).closes_at.getTime()).toBe(before + 10_000);
    await e.svc.controlLot({ lotId: s.lots[0], actorProfileId: seller.id, action: 'extend', seconds: 600 }); // capped at opened + 60 + 30
    const capped = (await e.lot(s.lots[0]));
    expect(capped.closes_at.getTime()).toBe(capped.opened_at.getTime() + 90_000);
    expect(await code(e.svc.controlLot({ lotId: s.lots[0], actorProfileId: seller.id, action: 'extend', seconds: 5 }))).toBe('wrong_state'); // at the cap
    expect(await code(e.svc.controlLot({ lotId: s.lots[1], actorProfileId: seller.id, action: 'extend', seconds: 5 }))).toBe('wrong_state'); // not open
    expect(await code(e.svc.controlLot({ lotId: s.lots[0], actorProfileId: seller.id, action: 'extend', seconds: 0 }))).toBe('validation');
  });

  t('a bid racing a withdraw: exactly one wins, and a withdrawn lot never has a bid', async (e) => {
    for (let round = 0; round < 10; round++) {
      const { seller, s, p } = await open(e);
      const [w, b] = await Promise.all([
        code(e.svc.controlLot({ lotId: s.lots[0], actorProfileId: seller.id, action: 'withdraw' })),
        e.bid(s.lots[0], p, 50n * USDC),
      ]);
      const lot = await e.lot(s.lots[0]);
      if (lot.state === 'withdrawn') { expect(b.ok).toBe(false); expect(lot.bid_count).toBe(0); expect(w).toBe('no error'); }
      else { expect(b.ok).toBe(true); expect(w).toBe('wrong_state'); expect(lot.bid_count).toBe(1); }
    }
  }, 120_000);
});

describe('show lifecycle for the seller', () => {
  t('go live needs ready lots; cancel only before start; end only when live; operators only on the house show', async (e) => {
    const seller = await e.profile(); const op = await e.profile();
    const actor = { profileId: seller.id, wallet: seller.wallet };
    const notReady = await e.show({ sellerId: seller.id, status: 'scheduled', lots: [{ consign: 'pending' }] });
    expect(await code(e.svc.startShow(notReady.id, actor))).toBe('lots_not_ready');
    const cancelled = await e.svc.cancelShow(notReady.id, actor);
    expect(cancelled.status).toBe('ended');
    expect((await e.pool.query(`select cancelled_at from shows where id=$1`, [notReady.id])).rows[0].cancelled_at).not.toBeNull();
    expect(await e.lot(notReady.lots[0])).toMatchObject({ state: 'withdrawn', closed_reason: 'cancelled' });
    expect(await code(e.svc.cancelShow(notReady.id, actor))).toBe('wrong_state');

    const live = await e.show({ sellerId: seller.id, lots: [{}] });
    expect(await code(e.svc.cancelShow(live.id, actor))).toBe('wrong_state');
    process.env.OPERATOR_WALLETS = op.wallet;
    try {
      expect(await code(e.svc.endShow(live.id, { profileId: op.id, wallet: op.wallet }))).toBe('not_seller'); // operators do not control third-party shows
      const house = await e.show({ sellerId: seller.id, isHouse: true, lots: [{}] });
      expect((await e.svc.endShow(house.id, { profileId: op.id, wallet: op.wallet })).status).toBe('ended');
    } finally { delete process.env.OPERATOR_WALLETS; }
    expect((await e.svc.endShow(live.id, actor)).status).toBe('ended');
  });

  t('patchLot edits terms before the lot opens, for the seller only', async (e) => {
    const seller = await e.profile(); const other = await e.profile();
    const s = await e.show({ sellerId: seller.id, lots: [{}, { state: 'open', openedAt: new Date(), closesAt: new Date(Date.now() + 60_000) }] });
    const l = await e.svc.patchLot({ lotId: s.lots[0], actorProfileId: seller.id, terms: { reserve: String(80n * USDC), increment: String(3n * USDC) } });
    expect(l).toMatchObject({ reserve: String(80n * USDC), increment: String(3n * USDC) });
    expect(await code(e.svc.patchLot({ lotId: s.lots[0], actorProfileId: other.id, terms: { reserve: '1' } }))).toBe('not_seller');
    expect(await code(e.svc.patchLot({ lotId: s.lots[1], actorProfileId: seller.id, terms: { reserve: '1' } }))).toBe('wrong_state');
    expect(await code(e.svc.patchLot({ lotId: s.lots[0], actorProfileId: seller.id, terms: {} }))).toBe('validation');
    expect(await code(e.svc.patchLot({ lotId: s.lots[0], actorProfileId: seller.id, terms: { increment: '0' } }))).toBe('validation');
  });
});

describe('registerPaddle', () => {
  t('numbers are 1..n, unique, and stable when a profile registers again', async (e) => {
    const seller = await e.profile();
    const s = await e.show({ sellerId: seller.id, lots: [{}] });
    const ps = await Promise.all(Array.from({ length: 25 }, () => e.profile()));
    const regs = await Promise.all(ps.map((p) => e.paddle(s.id, p.id)));
    expect(regs.map((r) => r.number).sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, n) => n + 1));
    const again = await e.svc.registerPaddle({ showId: s.id, profileId: ps[3].id, sessionPubkey: 'NewKey', maxBid: 5n * USDC, validUntil: new Date(Date.now() + 3600_000), authMessage: 'm2', authSignature: 's2' });
    expect(again).toMatchObject({ id: regs[3].id, number: regs[3].number, revokedAt: null });
    expect((await e.pool.query(`select session_pubkey, max_bid from paddles where id=$1`, [regs[3].id])).rows[0]).toMatchObject({ session_pubkey: 'NewKey', max_bid: String(5n * USDC) });
    // re-registering revives a revoked paddle
    await e.pool.query(`update paddles set revoked_at = now() where id=$1`, [regs[3].id]);
    expect((await e.svc.registerPaddle({ showId: s.id, profileId: ps[3].id, sessionPubkey: 'K3', maxBid: null, validUntil: new Date(Date.now() + 3600_000), authMessage: 'm', authSignature: 's' })).revokedAt).toBeNull();
  }, 120_000);

  t('refuses an ended show, a past expiry, a bad maximum and an unknown show', async (e) => {
    const seller = await e.profile(); const p = await e.profile();
    const live = await e.show({ sellerId: seller.id, lots: [{}] });
    const ended = await e.show({ sellerId: seller.id, status: 'ended', lots: [{}] });
    const reg = (showId: string, o: { validUntil?: Date; maxBid?: bigint | null } = {}) => e.svc.registerPaddle({ showId, profileId: p.id, sessionPubkey: 'K', maxBid: o.maxBid ?? null, validUntil: o.validUntil ?? new Date(Date.now() + 3600_000), authMessage: 'm', authSignature: 's' });
    expect(await code(reg(ended.id))).toBe('show_ended');
    expect(await code(reg(live.id, { validUntil: new Date(Date.now() - 1000) }))).toBe('validation');
    expect(await code(reg(live.id, { maxBid: 0n }))).toBe('validation');
    expect(await code(reg(live.id, { maxBid: 10n ** 12n + 1n }))).toBe('validation');
    expect(await code(reg('00000000-0000-4000-8000-000000000000'))).toBe('not_found');
    expect(await code(reg('nope'))).toBe('not_found');
  });
});

describe('catalogue and lists', () => {
  t('getCatalogue returns the show and lots in order, with no seller wallet or secret', async (e) => {
    const seller = await e.profile();
    const s = await e.show({ sellerId: seller.id, lots: [{}, {}, {}] });
    const d = await e.svc.getCatalogue(s.id);
    ShowDetail.parse(d);
    expect(d!.lots.map((l) => l.lotNumber)).toEqual([1, 2, 3]);
    expect(JSON.stringify(d)).not.toContain(seller.wallet);
    expect(await e.svc.getCatalogue('00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  t('listShows filters by status, reports counts and totals, pages with a cursor, and turns a due show live', async (e) => {
    await e.pool.query(`delete from show_events`); await e.pool.query(`delete from bids`); await e.pool.query(`delete from settlements`); await e.pool.query(`delete from paddles`); await e.pool.query(`delete from lots`); await e.pool.query(`delete from shows`);
    const seller = await e.profile();
    const ended = await e.show({ sellerId: seller.id, status: 'ended', lots: [{ state: 'sold', highBid: 70n * USDC, closedAt: new Date() }, { state: 'sold', highBid: 30n * USDC, closedAt: new Date() }, { state: 'passed', closedAt: new Date() }] });
    await e.pool.query(`update lots set image_url = 'https://example.test/' || lot_number where show_id=$1`, [ended.id]);
    const live = await e.show({ sellerId: seller.id, lots: [{ state: 'open', openedAt: new Date(), closesAt: new Date(Date.now() + 60_000) }] });
    const soon = await e.show({ sellerId: seller.id, status: 'scheduled', scheduledAt: new Date(Date.now() + 3600_000), lots: [{}] });
    const due = await e.show({ sellerId: seller.id, status: 'scheduled', scheduledAt: new Date(Date.now() - 1000), lots: [{}] });

    const liveList = ShowListResponse.parse(await e.svc.listShows({ status: 'live', limit: 20 }));
    expect(liveList.shows.map((x) => x.id).sort()).toEqual([live.id, due.id].sort()); // the due show went live because someone asked
    const endedList = ShowListResponse.parse(await e.svc.listShows({ status: 'ended', limit: 20 }));
    expect(endedList.shows).toHaveLength(1);
    expect(endedList.shows[0]).toMatchObject({ id: ended.id, lotCount: 3, soldCount: 2, hammerTotal: String(100n * USDC), cluster: 'devnet', isHouse: false });
    expect(endedList.shows[0].thumbs).toEqual(['https://example.test/1', 'https://example.test/2', 'https://example.test/3']);
    const sched = await e.svc.listShows({ status: 'scheduled', limit: 20 });
    expect(sched.shows.map((x) => x.id)).toEqual([soon.id]);

    const p1 = await e.svc.listShows({ limit: 2 });
    expect(p1.shows).toHaveLength(2);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await e.svc.listShows({ limit: 2, cursor: p1.nextCursor! });
    expect(p2.shows).toHaveLength(2);
    expect(p2.nextCursor).toBeNull();
    expect(new Set([...p1.shows, ...p2.shows].map((x) => x.id)).size).toBe(4);
    expect(p1.shows[0].status).toBe('live'); // live first
    expect((await e.svc.listShows({ limit: 2, cursor: 'garbage' })).shows).toHaveLength(2);
  });

  t('the demo (house) room is pinned first, seller rooms follow live, upcoming, ended, and seed shows are left out', async (e) => {
    await e.pool.query(`delete from show_events`); await e.pool.query(`delete from bids`); await e.pool.query(`delete from settlements`); await e.pool.query(`delete from paddles`); await e.pool.query(`delete from lots`); await e.pool.query(`delete from shows`);
    const seller = await e.profile();
    const seed = await e.profile({ wallet: SEED_SELLER_WALLET });
    const openLot = { state: 'open' as const, openedAt: new Date(), closesAt: new Date(Date.now() + 60_000) };
    // Seller rooms are created first and the demo room last, so a plain "newest first" order would put the demo room at the bottom.
    const ended = await e.show({ sellerId: seller.id, status: 'ended', lots: [{ state: 'passed', closedAt: new Date() }] });
    const soon = await e.show({ sellerId: seller.id, status: 'scheduled', scheduledAt: new Date(Date.now() + 3600_000), lots: [{}] });
    const sellerLive = await e.show({ sellerId: seller.id, lots: [openLot] });
    const seedLive = await e.show({ sellerId: seed.id, lots: [openLot] });
    const seedHouse = await e.show({ sellerId: seed.id, isHouse: true, lots: [openLot] }); // a house show is never hidden, whoever owns it
    const houseTimed = await e.show({ sellerId: seller.id, isHouse: true, lots: [openLot] });
    await e.pool.query(`update shows set kind = 'timed' where id = $1`, [houseTimed.id]);
    const house = await e.show({ sellerId: seller.id, isHouse: true, lots: [openLot] });

    const all = ShowListResponse.parse(await e.svc.listShows({ limit: 20 })).shows;
    const ids = all.map((x) => x.id);
    expect(ids).not.toContain(seedLive.id); // seed data is not a room a person made
    expect(ids).toContain(seedHouse.id);
    expect(ids.slice(0, 3).sort()).toEqual([house.id, houseTimed.id, seedHouse.id].sort()); // the demo shows first
    expect(all.slice(0, 3).filter((x) => x.kind === 'live').length).toBe(2); // live-kind before the timed house auction
    expect(all[2].kind).toBe('timed');
    expect(ids.slice(3)).toEqual([sellerLive.id, soon.id, ended.id]); // then live seller rooms, upcoming, ended
    expect(all.filter((x) => x.isHouse).map((x) => x.id).sort()).toEqual([house.id, houseTimed.id, seedHouse.id].sort());

    const onlyHouse = ShowListResponse.parse(await e.svc.listShows({ limit: 20, house: 'only' })).shows;
    expect(onlyHouse.every((x) => x.isHouse)).toBe(true);
    expect(onlyHouse).toHaveLength(3);
    const noHouse = ShowListResponse.parse(await e.svc.listShows({ limit: 20, house: 'exclude' })).shows;
    expect(noHouse.map((x) => x.id)).toEqual([sellerLive.id, soon.id, ended.id]);
    expect((await e.svc.listShows({ status: 'live', limit: 20 })).shows[0].isHouse).toBe(true); // pinned in a status list too
    // The legacy practice show id is left out as well.
    await e.pool.query(
      `insert into shows (id, seller_id, title, status, rules, settlement_mode, mode, is_house, cluster, started_at) values ($1,$2,'Practice','live','{}'::jsonb,'onchain','auto',false,'devnet',now())`,
      [DEMO_SHOW_ID, seller.id],
    );
    expect((await e.svc.listShows({ limit: 20, house: 'exclude' })).shows.map((x) => x.id)).toEqual([sellerLive.id, soon.id, ended.id]);
  });
});

describe('buyNow', () => {
  const PRICE = 300n * USDC;
  async function arena(e: Env, o: { price?: bigint | null; settlementMode?: string } = {}) {
    const seller = await e.profile();
    const s = await e.show({ sellerId: seller.id, settlementMode: o.settlementMode, rules: { gapS: 0 }, lots: [{ state: 'open', openedAt: new Date(), closesAt: new Date(Date.now() + 600_000), reserve: 100n * USDC }, {}] });
    if (o.price !== null) await e.pool.query(`update lots set buy_now_price=$2 where id=$1`, [s.lots[0], (o.price ?? PRICE).toString()]);
    const bob = await e.profile(); const amy = await e.profile();
    await e.paddle(s.id, bob.id); await e.paddle(s.id, amy.id);
    return { seller, s, lot: s.lots[0], bob, amy };
  }
  const buy = (e: Env, lotId: string, p: { id: string; wallet: string }, o: Partial<Parameters<Env['svc']['buyNow']>[0]> = {}) =>
    e.svc.buyNow({ lotId, buyerProfileId: p.id, buyerWallet: p.wallet, amount: PRICE, fundsBalance: 1000n * USDC, message: 'buy-now intent', signature: 'sig', nonce: `bn-${Math.random()}`, ...o });

  t('sells the lot at the Buy Now price, records the signed intent as the last bid, and creates the settlement', async (e) => {
    const a = await arena(e);
    await e.bid(a.lot, a.amy, 150n * USDC);
    const { settlementId } = await buy(e, a.lot, a.bob);
    const lot = await e.lot(a.lot);
    expect(lot).toMatchObject({ state: 'sold', closed_reason: 'buy_now', high_bid: String(PRICE), high_bidder_id: a.bob.id, bid_count: 2 });
    expect(lot.closes_at.getTime()).toBe(lot.closed_at.getTime());
    const { rows: [st] } = await e.pool.query(`select * from settlements where id=$1`, [settlementId]);
    expect(st).toMatchObject({ lot_id: a.lot, buyer_id: a.bob.id, seller_id: a.seller.id, status: 'awaiting_payment', rail: 'cosign', attempt: 1, gross_amount: String(PRICE), platform_fee: String(PRICE * 250n / 10000n) });
    expect(st.due_at.getTime()).toBe(lot.closed_at.getTime() + 900_000);
    const { rows: log } = await e.pool.query(`select message from bids where lot_id=$1`, [a.lot]);
    expect(log.map((r) => r.message)).toContain('buy-now intent'); // in the signed bid log the hash covers
    expect(st.bid_log_hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await e.events(a.s.id)).map((x) => x.kind)).toEqual(['bid.placed', 'bid.placed', 'lot.sold', 'settlement.awaiting']);
    // the lot is sold, so the next read opens the next lot (gap 0) and further bids are refused
    expect(await e.bid(a.lot, a.amy, 400n * USDC)).toMatchObject({ ok: false, code: 'lot_closed' });
    expect(await e.svc.advanceShow(a.s.id)).toMatchObject({ opened: 1 });
  });

  t('refuses: no price, wrong amount, bidding already at the price, funds, self, no paddle, closed lot, replay', async (e) => {
    const none = await arena(e, { price: null });
    expect(await code(buy(e, none.lot, none.bob))).toBe('not_buyable');
    const a = await arena(e);
    expect(await code(buy(e, a.lot, a.bob, { amount: PRICE - 1n }))).toBe('validation');
    expect(await code(buy(e, a.lot, a.bob, { fundsBalance: PRICE - 1n }))).toBe('insufficient_funds');
    expect(await code(buy(e, a.lot, a.seller))).toMatch(/self_bid|no_paddle/);
    const stranger = await e.profile();
    expect(await code(buy(e, a.lot, stranger))).toBe('no_paddle');
    expect(await code(buy(e, '00000000-0000-4000-8000-000000000000', a.bob))).toBe('not_found');
    await e.pool.query(`update lots set high_bid=$2 where id=$1`, [a.lot, PRICE.toString()]);
    expect(await code(buy(e, a.lot, a.bob))).toBe('not_buyable');
    await e.pool.query(`update lots set high_bid=null, state='sold' where id=$1`, [a.lot]);
    expect(await code(buy(e, a.lot, a.bob))).toBe('lot_closed');
    const b = await arena(e);
    await buy(e, b.lot, b.bob, { nonce: 'same' });
    const c = await arena(e);
    await e.paddle(c.s.id, b.bob.id); // nonces are unique per bidder, across lots
    expect(await code(buy(e, c.lot, b.bob, { nonce: 'same' }))).toBe('replay');
  });

  t('an expired lot is closed lazily instead of sold at Buy Now; a legacy show (no settlement mode) cannot be bought', async (e) => {
    const a = await arena(e);
    await e.pool.query(`update lots set closes_at = now() - interval '1 second' where id=$1`, [a.lot]);
    expect(await code(buy(e, a.lot, a.bob))).toBe('lot_closed');
    expect((await e.lot(a.lot)).state).toBe('passed');
    const legacy = await arena(e, { settlementMode: 'none' });
    expect(await code(buy(e, legacy.lot, legacy.bob))).toBe('not_buyable');
  });

  t('10 buyers at once: exactly one wins, one settlement', async (e) => {
    const a = await arena(e);
    const buyers = []; for (let n = 0; n < 10; n++) { const p = await e.profile(); await e.paddle(a.s.id, p.id); buyers.push(p); }
    const rs = await Promise.all(buyers.map((p) => code(buy(e, a.lot, p))));
    expect(rs.filter((r) => r === 'no error')).toHaveLength(1);
    expect(rs.filter((r) => r !== 'no error').every((r) => r === 'lot_closed')).toBe(true);
    expect((await e.pool.query(`select count(*)::int as n from settlements where lot_id=$1`, [a.lot])).rows[0].n).toBe(1);
    expect((await e.lot(a.lot)).bid_count).toBe(1);
  });
});

describe('lot duration chosen by the seller (K14)', () => {
  const mk = (e: Env, sellerId: string, n: number, rules?: Record<string, number>) =>
    e.svc.createShow({ title: 'Lot length show', sellerProfileId: sellerId, ...(rules ? { rules } : {}), lots: [{ mint: mint(n), reserve: String(100n * USDC) }], readiness: { [mint(n)]: ok } });

  t('keeps 45 s when the seller chooses nothing, and the show says so', async (e) => {
    const seller = await e.profile();
    const d = await mk(e, seller.id, 40);
    expect(d.show.lotDurationS).toBe(45);
    ShowDetail.parse(d);
    const { rows: [s] } = await e.pool.query(`select rules from shows where id=$1`, [d.show.id]);
    expect(s.rules).toEqual({});
    await e.svc.startShow(d.show.id, { profileId: seller.id, wallet: seller.wallet });
    const lot = (await e.pool.query(`select opened_at, closes_at from lots where show_id=$1`, [d.show.id])).rows[0];
    expect(lot.closes_at.getTime() - lot.opened_at.getTime()).toBe(45_000);
  });

  t('each preset becomes the length the first lot really gets, and the catalogue and the snapshot carry it', async (e) => {
    for (const [i, s] of ([90, 180, 300] as const).entries()) {
      const seller = await e.profile();
      const d = await mk(e, seller.id, 41 + i, { lotDurationS: s });
      expect(d.show.lotDurationS).toBe(s);
      expect((await e.svc.getCatalogue(d.show.id))?.show.lotDurationS).toBe(s);
      await e.svc.startShow(d.show.id, { profileId: seller.id, wallet: seller.wallet });
      const lot = (await e.pool.query(`select opened_at, closes_at from lots where show_id=$1`, [d.show.id])).rows[0];
      expect(lot.closes_at.getTime() - lot.opened_at.getTime()).toBe(s * 1000);
      const snap = LiveSnapshot.parse(await e.svc.getLiveSnapshot(d.show.id));
      expect(Date.parse(snap.current!.closesAt!) - lot.opened_at.getTime()).toBe(s * 1000);
    }
  });

  t('a length outside 10 s to 1 h is clamped as it always was, and the show reports the length the room will really use', async (e) => {
    for (const [i, [asked, got]] of ([[5, 10], [10, 10], [30, 30], [3600, 3600], [3601, 3600], [100_000, 3600]] as const).entries()) {
      const d = await mk(e, (await e.profile()).id, 60 + i, { lotDurationS: asked }); // a card per show: one card, one place
      expect(d.show.lotDurationS, String(asked)).toBe(got);
      expect((await e.svc.getCatalogue(d.show.id))?.show.lotDurationS).toBe(got);
    }
  });

  t('the anti-sniping cap scales with a longer lot: 5 min lot, cap is opened + 5 min + 120 s', async (e) => {
    const seller = await e.profile(); const bob = await e.profile();
    const d = await mk(e, seller.id, 52, { lotDurationS: 300 });
    await e.svc.startShow(d.show.id, { profileId: seller.id, wallet: seller.wallet });
    await e.paddle(d.show.id, bob.id);
    const lotId = (await e.pool.query(`select id from lots where show_id=$1`, [d.show.id])).rows[0].id;
    await e.pool.query(`update lots set opened_at = now() - interval '295 seconds', closes_at = now() + interval '5 seconds' where id=$1`, [lotId]);
    expect(await e.bid(lotId, bob, 50n * USDC)).toMatchObject({ ok: true, extended: true }); // inside the 15 s window
    const lot = await e.lot(lotId);
    expect(lot.closes_at.getTime() - lot.opened_at.getTime()).toBeLessThanOrEqual((300 + 120) * 1000);
    expect(lot.closes_at.getTime() - Date.now()).toBeGreaterThan(14_000);
  });
});
