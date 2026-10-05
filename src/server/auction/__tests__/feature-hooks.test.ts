/**
 * The foundation hooks of the optional features, on a real Postgres with the real service:
 *   - a drawn lot order holds the show back until the draw is revealed, defaults at its deadline, and never touches a catalogue show,
 *   - createShow persists the kind, the order mode, the video choice and the descriptions, and refuses what a switch has not enabled,
 *   - the snapshot says whether video is enabled (the seller's choice AND the switch) and where the order stands, never a host or a path.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LiveSnapshot, ShowDetail, ShowListResponse } from '@/contracts';
import { clearFlagMemo } from '@/app/api/auctions/_shared/flags';
import { startEnv, USDC, type Env } from './harness';

let env: Env | undefined; let skipReason: string | undefined;
beforeAll(async () => { const r = await startEnv(); if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); } else env = r.env; }, 180_000);
afterAll(async () => { await env?.stop(); });
afterEach(() => { vi.unstubAllEnvs(); clearFlagMemo(); });
const t = (name: string, fn: (e: Env) => Promise<void>, timeout = 60_000) => it(name, async (ctx) => { if (!env) return ctx.skip(skipReason); await fn(env); }, timeout);

const T0 = new Date('2026-10-05T18:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

async function drawnShow(e: Env, o: { request?: { status: string; revealByMs: number } | null; mode?: 'vrf' | 'catalogue'; lots?: number } = {}) {
  const seller = await e.profile();
  const s = await e.show({ sellerId: seller.id, status: 'live', rules: { lotDurationS: 20, gapS: 6 }, lots: Array.from({ length: o.lots ?? 2 }, () => ({})) });
  await e.pool.query(`update shows set order_mode = $2 where id = $1`, [s.id, o.mode ?? 'vrf']);
  if (o.request) {
    await e.pool.query(
      `insert into vrf_requests (purpose, subject_type, subject_id, cluster, public_key, params, params_hash, status, reveal_by)
       values ('lot_order', 'show', $1, 'devnet', 'K', '{}', 'h', $2, $3)`,
      [s.id, o.request.status, new Date(o.request.revealByMs)],
    );
  }
  const request = async () => (await e.pool.query(`select status, defaulted_at, result from vrf_requests where subject_id = $1`, [s.id])).rows[0];
  const states = async () => (await e.pool.query(`select state from lots where show_id = $1 order by lot_number`, [s.id])).rows.map((r) => r.state as string);
  return { ...s, request, states };
}

describe('the drawn lot order gates the show', () => {
  t('a pending draw holds the first lot back until its deadline, then defaults and opens it in the same tick', async (e) => {
    const s = await drawnShow(e, { request: { status: 'pending', revealByMs: T0.getTime() + 120_000 } });
    expect(await e.svc.advanceShow(s.id, at(10_000))).toEqual({ showId: s.id, wentLive: false, closed: 0, opened: 0, ended: false });
    expect(await s.states()).toEqual(['catalogued', 'catalogued']);
    expect(await e.svc.advanceShow(s.id, at(119_999))).toMatchObject({ opened: 0, ended: false });
    expect((await s.request()).status).toBe('pending');

    expect(await e.svc.advanceShow(s.id, at(120_000))).toEqual({ showId: s.id, wentLive: false, closed: 0, opened: 1, ended: false });
    expect(await s.states()).toEqual(['open', 'catalogued']);
    const r = await s.request();
    expect(r.status).toBe('defaulted');
    expect(r.defaulted_at.getTime()).toBe(T0.getTime() + 120_000);
    expect(r.result).toEqual({ order: s.lots, applied: false }); // the catalogue order is what applies
    expect(await e.svc.advanceShow(s.id, at(120_000))).toMatchObject({ opened: 0 }); // idempotent
  });

  t('a committed draw waits the same way', async (e) => {
    const s = await drawnShow(e, { request: { status: 'committed', revealByMs: T0.getTime() + 60_000 } });
    expect(await e.svc.advanceShow(s.id, at(59_000))).toMatchObject({ opened: 0 });
    expect(await e.svc.advanceShow(s.id, at(60_001))).toMatchObject({ opened: 1 });
    expect((await s.request()).status).toBe('defaulted');
  });

  t('a show with no lot to open is not ended while it waits, and ends after the deadline', async (e) => {
    const s = await drawnShow(e, { lots: 0, request: { status: 'pending', revealByMs: T0.getTime() + 30_000 } });
    expect(await e.svc.advanceShow(s.id, at(1_000))).toMatchObject({ ended: false });
    expect((await e.pool.query(`select status from shows where id = $1`, [s.id])).rows[0].status).toBe('live');
    expect(await e.svc.advanceShow(s.id, at(30_000))).toMatchObject({ ended: true });
  });

  t('a revealed draw, a defaulted draw and a missing request do not hold the show back', async (e) => {
    for (const request of [{ status: 'revealed', revealByMs: T0.getTime() + 999_000 }, { status: 'defaulted', revealByMs: T0.getTime() + 999_000 }, null]) {
      const s = await drawnShow(e, { request });
      expect(await e.svc.advanceShow(s.id, at(1_000)), JSON.stringify(request)).toMatchObject({ opened: 1 });
      if (request) expect((await s.request()).status).toBe(request.status); // nothing is rewritten
    }
  });

  t('a catalogue show never reads the draw: a stray request row changes nothing', async (e) => {
    const s = await drawnShow(e, { mode: 'catalogue', request: { status: 'pending', revealByMs: T0.getTime() + 999_000 } });
    expect(await e.svc.advanceShow(s.id, at(1_000))).toMatchObject({ opened: 1 });
    expect((await s.request()).status).toBe('pending');
  });

  t('a draw only ever concerns its own show', async (e) => {
    const waiting = await drawnShow(e, { request: { status: 'pending', revealByMs: T0.getTime() + 120_000 } });
    const other = await drawnShow(e, { request: null });
    expect(await e.svc.advanceShow(other.id, at(1_000))).toMatchObject({ opened: 1 });
    expect(await e.svc.advanceShow(waiting.id, at(1_000))).toMatchObject({ opened: 0 });
  });
});

describe('the snapshot says where the order stands and whether video is on', () => {
  t('a drawn order carries its status and request id; a catalogue show says only the mode', async (e) => {
    // The snapshot reads the real clock, so the deadline is relative to now (a fixed date would turn into 'defaulted' once it has passed).
    const s = await drawnShow(e, { request: { status: 'committed', revealByMs: Date.now() + 600_000 } });
    const snap = LiveSnapshot.parse(await e.svc.getLiveSnapshot(s.id));
    const reqId = (await e.pool.query(`select id from vrf_requests where subject_id = $1`, [s.id])).rows[0].id;
    expect(snap.show).toMatchObject({ kind: 'live', order: { mode: 'vrf', status: 'committed', requestId: reqId }, video: { enabled: false } });

    const plain = await drawnShow(e, { mode: 'catalogue' });
    expect(LiveSnapshot.parse(await e.svc.getLiveSnapshot(plain.id)).show.order).toEqual({ mode: 'catalogue' });
    const noRequest = await drawnShow(e, { request: null });
    expect(LiveSnapshot.parse(await e.svc.getLiveSnapshot(noRequest.id)).show.order).toEqual({ mode: 'vrf' });
  });

  t('video is enabled only when the seller chose it AND the feature is on, and the snapshot never names a host or a path', async (e) => {
    const seller = await e.profile();
    const s = await e.show({ sellerId: seller.id, status: 'live', lots: [{ state: 'open', openedAt: T0, closesAt: new Date(Date.now() + 600_000) }] });
    await e.pool.query(`update shows set video_enabled = true where id = $1`, [s.id]);
    const enabled = async () => { clearFlagMemo(); return LiveSnapshot.parse(await e.svc.getLiveSnapshot(s.id)).show.video.enabled; };

    expect(await enabled()).toBe(false); // the choice alone is not enough
    vi.stubEnv('FEATURE_VIDEO', 'true');
    vi.stubEnv('MEDIA_SERVER_URL', 'media.example.test');
    vi.stubEnv('NEXT_PUBLIC_MEDIA_SERVER_URL', 'media.example.test');
    expect(await enabled()).toBe(true);
    const text = JSON.stringify(await e.svc.getLiveSnapshot(s.id)) + JSON.stringify(await e.svc.getCatalogue(s.id));
    expect(text).not.toMatch(/media\.example|hls|m3u8|ingest|publish/i);

    await e.pool.query(`insert into app_flags (key, value) values ('video', 'false'::jsonb)`);
    expect(await enabled()).toBe(false); // the kill switch
    await e.pool.query(`delete from app_flags where key = 'video'`);
    await e.pool.query(`update shows set video_enabled = false where id = $1`, [s.id]);
    expect(await enabled()).toBe(false); // the feature alone is not enough either
  });
});

describe('createShow persists the optional fields', () => {
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const mint = () => Array.from({ length: 44 }, () => B58[Math.floor(Math.random() * B58.length)]).join('');
  const make = async (e: Env, over: Record<string, unknown> = {}, lotOver: Record<string, unknown> = {}) => {
    const seller = await e.profile();
    const m = mint();
    return e.svc.createShow({
      title: 'Features show', format: 'auction', mode: 'auto', sellerProfileId: seller.id,
      lots: [{ mint: m, reserve: String(100n * USDC), openingPrice: String(50n * USDC), increment: String(5n * USDC), ...lotOver }],
      readiness: { [m]: { eligible: true, reasons: [] } }, assets: { [m]: { name: 'Charizard' } }, ...over,
    } as Parameters<typeof e.svc.createShow>[0]);
  };

  t('defaults: a live show, catalogue order, no video, no description', async (e) => {
    const d = ShowDetail.parse(await make(e));
    expect(d.show).toMatchObject({ kind: 'live', orderMode: 'catalogue', video: { enabled: false } });
    expect(d.lots[0]).toMatchObject({ description: null, aiAssisted: false });
    const row = (await e.pool.query(`select kind, order_mode, video_enabled from shows where id = $1`, [d.show.id])).rows[0];
    expect(row).toEqual({ kind: 'live', order_mode: 'catalogue', video_enabled: false });
  });

  t('descriptions and the AI mark are stored per lot (the mark only together with a description)', async (e) => {
    const d = ShowDetail.parse(await make(e, {}, { description: { de: 'Text de', en: 'Text en' }, aiAssisted: true }));
    expect(d.lots[0]).toMatchObject({ description: { de: 'Text de', en: 'Text en' }, aiAssisted: true });
    const row = (await e.pool.query(`select description, ai_assisted from lots where show_id = $1`, [d.show.id])).rows[0];
    expect(row).toEqual({ description: { de: 'Text de', en: 'Text en' }, ai_assisted: true });
    const noText = ShowDetail.parse(await make(e, {}, { aiAssisted: true }));
    expect(noText.lots[0]).toMatchObject({ description: null, aiAssisted: false });
    expect(ShowDetail.parse(await e.svc.getCatalogue(d.show.id)).lots[0].description).toEqual({ de: 'Text de', en: 'Text en' });
  });

  t('the video choice counts only where the feature is on: it is not stored as a "yes" that could switch on later', async (e) => {
    const off = ShowDetail.parse(await make(e, { videoEnabled: true }));
    expect(off.show.video.enabled).toBe(false);
    expect((await e.pool.query(`select video_enabled from shows where id = $1`, [off.show.id])).rows[0].video_enabled).toBe(false);

    vi.stubEnv('FEATURE_VIDEO', 'true'); clearFlagMemo();
    const on = ShowDetail.parse(await make(e, { videoEnabled: true }));
    expect(on.show.video.enabled).toBe(true);
    expect((await e.pool.query(`select video_enabled from shows where id = $1`, [on.show.id])).rows[0].video_enabled).toBe(true);
    expect(ShowDetail.parse(await make(e, { videoEnabled: false })).show.video.enabled).toBe(false);
  });

  t('a timed show is refused while FEATURE_TIMED is off (feature_off), and stored as timed when it is on', async (e) => {
    await expect(make(e, { kind: 'timed', isHouse: true })).rejects.toMatchObject({ code: 'feature_off', status: 404 });
    expect((await e.pool.query(`select count(*)::int n from shows where kind = 'timed'`)).rows[0].n).toBe(0); // nothing was written
    vi.stubEnv('FEATURE_TIMED', 'true'); clearFlagMemo();
    const d = ShowDetail.parse(await make(e, { kind: 'timed', isHouse: true }));
    expect(d.show.kind).toBe('timed');
    await e.pool.query(`insert into app_flags (key, value) values ('timed', 'false'::jsonb)`);
    clearFlagMemo();
    await expect(make(e, { kind: 'timed', isHouse: true })).rejects.toMatchObject({ code: 'feature_off' }); // the kill switch
    await e.pool.query(`delete from app_flags where key = 'timed'`);
  });

  t('a drawn order is set by the server only, and the lists carry and filter by kind', async (e) => {
    vi.stubEnv('FEATURE_TIMED', 'true'); clearFlagMemo();
    const drawn = ShowDetail.parse(await make(e, { orderMode: 'vrf', isHouse: false }));
    expect(drawn.show.orderMode).toBe('vrf');
    const timed = ShowDetail.parse(await make(e, { kind: 'timed', isHouse: true }));
    const all = ShowListResponse.parse(await e.svc.listShows({ limit: 50 }));
    expect(all.shows.find((x) => x.id === timed.show.id)).toMatchObject({ kind: 'timed' });
    const onlyTimed = ShowListResponse.parse(await e.svc.listShows({ kind: 'timed', limit: 50 }));
    expect(onlyTimed.shows.length).toBeGreaterThan(0);
    expect(onlyTimed.shows.every((x) => x.kind === 'timed')).toBe(true);
    expect(ShowListResponse.parse(await e.svc.listShows({ kind: 'live', limit: 50 })).shows.every((x) => x.kind === 'live')).toBe(true);
  });
});
