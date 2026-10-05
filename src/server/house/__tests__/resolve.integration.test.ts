/**
 * /room/house on a real Postgres 18 with the real engine: the link must land in a room that is LIVE right now. Live house show first, a live timed
 * lot when no house show is live, a due show is started on the read, a show scheduled for the future is reported (never redirected into), an ended
 * show is only the last resort.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startEnv, type Env } from '@/server/auction/__tests__/harness';

let env: Env | undefined; let skipReason: string | undefined;
let resolveHouseRoom: typeof import('../resolve').resolveHouseRoom;
let sellerId = '';

const noKeepAlive = { keepAlive: async () => null };
const open = () => [{ state: 'open' as const, openedAt: new Date(), closesAt: new Date(Date.now() + 3_600_000) }];

beforeAll(async () => {
  const r = await startEnv();
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  env = r.env;
  ({ resolveHouseRoom } = await import('../resolve'));
}, 180_000);
afterAll(async () => { await env?.stop(); });
beforeEach(async () => {
  if (!env) return;
  await env.pool.query(`delete from vrf_requests; delete from paddles; delete from show_events; delete from settlements; delete from bids; delete from lots; delete from shows`);
  sellerId = (await env.profile()).id;
});

const t = (name: string, fn: (e: Env) => Promise<void>, timeout = 60_000) => it(name, async (ctx) => { if (!env) return ctx.skip(skipReason); await fn(env); }, timeout);
const timed = async (e: Env, id: string) => { await e.pool.query(`update shows set kind = 'timed' where id = $1`, [id]); return id; };
const houseShow = (e: Env, o: Partial<Parameters<Env['show']>[0]> = {}) => e.show({ sellerId, isHouse: true, lots: [{}], ...o });

describe('resolveHouseRoom', () => {
  t('live + scheduled + ended house shows: the live one, even when the others are newer', async (e) => {
    const live = await houseShow(e, { status: 'live', lots: open() });
    await houseShow(e, { status: 'ended', lots: [{ state: 'sold', closedAt: new Date() }] });
    await houseShow(e, { status: 'scheduled', scheduledAt: new Date(Date.now() + 5 * 60_000) });
    expect(await resolveHouseRoom({ deps: noKeepAlive })).toMatchObject({ id: live.id, status: 'live', kind: 'live' });
  });

  t('the live house show wins over live timed lots; prefer timed picks a timed lot', async (e) => {
    const live = await houseShow(e, { status: 'live', lots: open() });
    const t1 = await timed(e, (await houseShow(e, { status: 'live', lots: open() })).id);
    const t2 = await timed(e, (await houseShow(e, { status: 'live', lots: open() })).id);
    expect((await resolveHouseRoom({ deps: noKeepAlive }))?.id).toBe(live.id);
    expect([t1, t2]).toContain((await resolveHouseRoom({ prefer: 'timed', deps: noKeepAlive }))?.id);
  });

  t('no live house show but two live timed lots and a future scheduled show: a live timed lot, not the scheduled show', async (e) => {
    await houseShow(e, { status: 'scheduled', scheduledAt: new Date(Date.now() + 8 * 60_000) });
    const t1 = await timed(e, (await houseShow(e, { status: 'live', lots: open() })).id);
    const t2 = await timed(e, (await houseShow(e, { status: 'live', lots: open() })).id);
    const got = await resolveHouseRoom({ deps: noKeepAlive });
    expect(got).toMatchObject({ status: 'live', kind: 'timed' });
    expect([t1, t2]).toContain(got!.id);
  });

  t('only a scheduled show that is DUE: it is started on the read and the answer is that live room', async (e) => {
    const due = await houseShow(e, { status: 'scheduled', scheduledAt: new Date(Date.now() - 60_000) });
    const got = await resolveHouseRoom({ deps: noKeepAlive });
    expect(got).toMatchObject({ id: due.id, status: 'live' });
    expect((await e.pool.query(`select state from lots where show_id = $1`, [due.id])).rows[0].state).toBe('open');
  });

  t('only a scheduled show for the future: reported as scheduled with its start, and nothing is started', async (e) => {
    const at = new Date(Date.now() + 5 * 60_000);
    const next = await houseShow(e, { status: 'scheduled', scheduledAt: at });
    const got = await resolveHouseRoom({ deps: noKeepAlive });
    expect(got).toMatchObject({ id: next.id, status: 'scheduled', startsAt: at.toISOString() });
    expect((await e.pool.query(`select status from shows where id = $1`, [next.id])).rows[0].status).toBe('scheduled');
  });

  t('a scheduled show is reported over an ended one (the page explains and links, it never redirects into it)', async (e) => {
    await houseShow(e, { status: 'ended', lots: [{ state: 'sold', closedAt: new Date() }] });
    const next = await houseShow(e, { status: 'scheduled', scheduledAt: new Date(Date.now() + 5 * 60_000) });
    expect(await resolveHouseRoom({ deps: noKeepAlive })).toMatchObject({ id: next.id, status: 'scheduled' });
  });

  t('only ended shows: the last one that ended; no house show at all: null', async (e) => {
    expect(await resolveHouseRoom({ deps: noKeepAlive })).toBeNull();
    const old = await houseShow(e, { status: 'ended', lots: [{ state: 'sold', closedAt: new Date() }] });
    await e.pool.query(`update shows set ended_at = now() - interval '2 hours' where id = $1`, [old.id]);
    const last = await houseShow(e, { status: 'ended', lots: [{ state: 'sold', closedAt: new Date() }] });
    await e.pool.query(`update shows set ended_at = now() - interval '1 hour' where id = $1`, [last.id]);
    expect(await resolveHouseRoom({ deps: noKeepAlive })).toMatchObject({ id: last.id, status: 'ended' });
  });

  t('a failing rollover never fails the link', async (e) => {
    const live = await houseShow(e, { status: 'live', lots: open() });
    expect((await resolveHouseRoom({ deps: { keepAlive: async () => { throw new Error('rpc down'); } } }))?.id).toBe(live.id);
  });

  t('shows of sellers (not house) are never the house room', async (e) => {
    await e.show({ sellerId, status: 'live', lots: open() });
    expect(await resolveHouseRoom({ deps: noKeepAlive })).toBeNull();
  });
});
