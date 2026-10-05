/**
 * Optional live video through the real route handlers (embedded Postgres 18, real sessions) against the local fake media server
 * (fake-media.mjs). What is proved here: the publish credential and the API key exist only on the hop to the media server
 * and in no answer, header or log; who may send; the limits on the SDP; the per-show path; the playback answer; the kill switch.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ErrorResponseSchema, PlaybackResponse } from '@/contracts';
import { startFakeMedia } from '@/server/streams/__tests__/fake-media.mjs';
import { actor, bodyOf, idCtx, req, resetLimits, signIn, startKit, type Kit } from '../../auctions/_shared/__tests__/kit';

type H = (r: Request, c: { params: Promise<Record<string, string>> }) => Promise<Response>;
let kit: Kit | undefined;
let skipReason: string | undefined;
let media: Awaited<ReturnType<typeof startFakeMedia>>;
let h: { toggle: H; playback: H; whip: H; whipStop: H; catalogue: H };
let clearFlagMemo: () => void;
let clearPlayback: () => void;

const USER = 'fake-user';
const PASS = 'fake-pass-9f3a1c77';
const KEY = 'fake-api-key-5d21b0e4';
const BASIC = Buffer.from(`${USER}:${PASS}`).toString('base64');
const OFFER = 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\n';

/** Everything the server answered in this file: nothing in it may contain a credential. */
const answers: string[] = [];
const keep = async (res: Response) => { answers.push(`${res.status} ${[...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n')}\n${await res.clone().text()}`); return res; };

beforeAll(async () => {
  const r = await startKit();
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  kit = r.kit;
  media = await startFakeMedia({ apiKey: KEY, publishUser: USER, publishPass: PASS });
  vi.stubEnv('FEATURE_VIDEO', 'true');
  vi.stubEnv('MEDIA_SERVER_URL', `127.0.0.1:${media.port}`);
  vi.stubEnv('NEXT_PUBLIC_MEDIA_SERVER_URL', `127.0.0.1:${media.port}`);
  vi.stubEnv('MEDIA_SERVER_WEBRTC_PORT', String(media.port));
  vi.stubEnv('MEDIA_SERVER_API_URL', media.url);
  vi.stubEnv('MEDIA_SERVER_API_KEY', KEY);
  vi.stubEnv('MEDIAMTX_PUBLISH_USER', USER);
  vi.stubEnv('MEDIAMTX_PUBLISH_PASS', PASS);
  vi.stubEnv('VIDEO_ALLOW_INSECURE_TARGET', 'true');
  h = {
    toggle: (await import('@/app/api/shows/[id]/video/route')).POST as unknown as H,
    playback: (await import('../[showId]/playback/route')).GET as unknown as H,
    whip: (await import('../[showId]/whip/route')).POST as unknown as H,
    whipStop: (await import('../[showId]/whip/[sessionId]/route')).DELETE as unknown as H,
    catalogue: (await import('@/app/api/shows/[id]/route')).GET as unknown as H,
  };
  clearFlagMemo = (await import('@/app/api/auctions/_shared/flags')).clearFlagMemo;
  clearPlayback = (await import('@/server/streams/service'))._clearPlaybackMemo;
}, 180_000);

afterAll(async () => {
  if (media) await media.close();
  await kit?.stop();
});
afterEach(() => { vi.stubEnv('OPERATOR_WALLETS', ''); vi.stubEnv('VIDEO_SENDERS', ''); });

const t = (name: string, fn: (k: Kit) => Promise<void>, timeout = 60_000) => it(name, async (ctx) => { if (!kit) return ctx.skip(skipReason); await fn(kit); }, timeout);
const code = async (res: Response) => ErrorResponseSchema.parse(await res.json()).code;
const sid = (id: string) => ({ params: Promise.resolve({ showId: id }) });
const sidSession = (id: string, sessionId: string) => ({ params: Promise.resolve({ showId: id, sessionId }) });

/** A signed-in wallet with its profile id. */
async function person(k: Kit) {
  const a = actor();
  const cookie = await signIn(a);
  const id = (await k.env.pool.query(`select id from profiles where wallet_address = $1`, [a.wallet])).rows[0].id as string;
  return { a, cookie, id };
}

/** A show owned by `sellerId` with video enabled (the column the checkbox sets) unless told otherwise. */
async function show(k: Kit, sellerId: string, o: { video?: boolean; status?: 'scheduled' | 'live' | 'ended'; isHouse?: boolean } = {}) {
  const s = await k.env.show({ sellerId, status: o.status ?? 'scheduled', isHouse: o.isHouse, lots: [{}] });
  await k.env.pool.query(`update shows set video_enabled = $2 where id = $1`, [s.id, o.video ?? true]);
  clearPlayback();
  return s.id;
}

const whipReq = (id: string, cookie: string | undefined, o: { body?: string; type?: string; ip?: string } = {}) =>
  req(`/api/streams/${id}/whip`, { method: 'POST', body: o.body ?? OFFER, cookie, ip: o.ip, headers: { 'content-type': o.type ?? 'application/sdp' } });

describe('POST /api/shows/:id/video', () => {
  t('the seller switches video on and off; the column follows; a stranger and a signed-out caller are refused', async (k) => {
    const s = await person(k);
    const id = await show(k, s.id, { video: false });
    const on = await keep(await h.toggle(req(`/api/shows/${id}/video`, { body: { enabled: true }, cookie: s.cookie }), idCtx(id) as never));
    expect(on.status).toBe(200);
    expect(await bodyOf(on)).toEqual({ video: { enabled: true } });
    expect((await k.env.pool.query(`select video_enabled from shows where id=$1`, [id])).rows[0].video_enabled).toBe(true);
    const off = await h.toggle(req(`/api/shows/${id}/video`, { body: { enabled: false }, cookie: s.cookie }), idCtx(id) as never);
    expect((await bodyOf(off)).video.enabled).toBe(false);
    expect((await k.env.pool.query(`select video_enabled from shows where id=$1`, [id])).rows[0].video_enabled).toBe(false);

    // The show manager reads this catalogue: it must carry the seller's choice (it once always said false), and only while the feature is on.
    const catalogue = async () => (await bodyOf(await h.catalogue(req(`/api/shows/${id}`), idCtx(id) as never))).show.video.enabled;
    expect(await catalogue()).toBe(false);
    await h.toggle(req(`/api/shows/${id}/video`, { body: { enabled: true }, cookie: s.cookie }), idCtx(id) as never);
    expect(await catalogue()).toBe(true);
    vi.stubEnv('FEATURE_VIDEO', 'false');
    clearFlagMemo();
    expect(await catalogue()).toBe(false);
    vi.stubEnv('FEATURE_VIDEO', 'true');
    clearFlagMemo();
    await h.toggle(req(`/api/shows/${id}/video`, { body: { enabled: false }, cookie: s.cookie }), idCtx(id) as never);

    const stranger = await person(k);
    expect(await code(await h.toggle(req(`/api/shows/${id}/video`, { body: { enabled: true }, cookie: stranger.cookie }), idCtx(id) as never))).toBe('not_seller');
    expect(await code(await h.toggle(req(`/api/shows/${id}/video`, { body: { enabled: true } }), idCtx(id) as never))).toBe('unauthenticated');
  });

  t('refuses a wrong body, a cross-origin write, an ended show and an unknown show; honours the feature switch and the kill switch', async (k) => {
    const s = await person(k);
    const id = await show(k, s.id, { video: false });
    const post = (body: unknown, extra: Record<string, string> = {}) => h.toggle(req(`/api/shows/${id}/video`, { body, cookie: s.cookie, headers: extra }), idCtx(id) as never);
    expect(await code(await post({ enabled: 'yes' }))).toBe('validation');
    expect(await code(await post({ enabled: true, extra: 1 }))).toBe('validation');
    expect(await code(await post({ enabled: true }, { origin: 'https://evil.example' }))).toBe('forbidden');
    const ended = await show(k, s.id, { status: 'ended' });
    expect(await code(await h.toggle(req(`/api/shows/${ended}/video`, { body: { enabled: true }, cookie: s.cookie }), idCtx(ended) as never))).toBe('wrong_state');
    const none = '3f6c1f2e-9b0a-4f43-8a52-1d7a0c5e7b10';
    expect(await code(await h.toggle(req(`/api/shows/${none}/video`, { body: { enabled: true }, cookie: s.cookie }), idCtx(none) as never))).toBe('not_found');

    vi.stubEnv('FEATURE_VIDEO', 'false');
    clearFlagMemo();
    const res = await post({ enabled: true });
    expect(res.status).toBe(404);
    expect(await code(res)).toBe('feature_off');
    vi.stubEnv('FEATURE_VIDEO', 'true');
    clearFlagMemo();

    await k.env.pool.query(`insert into app_flags (key, value) values ('video', 'false'::jsonb) on conflict (key) do update set value = excluded.value`);
    clearFlagMemo();
    expect(await code(await post({ enabled: true }))).toBe('feature_off');
    await k.env.pool.query(`delete from app_flags where key = 'video'`);
    clearFlagMemo();
    expect((await post({ enabled: true })).status).toBe(200);
  });

  t('refuses to switch video on while the media-server settings are incomplete (it would read back as off everywhere), and still switches it off', async (k) => {
    const s = await person(k);
    const id = await show(k, s.id, { video: false });
    const post = (enabled: boolean) => h.toggle(req(`/api/shows/${id}/video`, { body: { enabled }, cookie: s.cookie }), idCtx(id) as never);
    const column = async () => (await k.env.pool.query(`select video_enabled from shows where id=$1`, [id])).rows[0].video_enabled;
    try {
      vi.stubEnv('MEDIAMTX_PUBLISH_PASS', '');
      const refused = await post(true);
      expect(refused.status).toBe(503);
      expect(await code(refused)).toBe('video_unavailable');
      expect(await column()).toBe(false);
      vi.stubEnv('MEDIAMTX_PUBLISH_PASS', PASS);
      expect((await post(true)).status).toBe(200);
      expect(await column()).toBe(true);
      vi.stubEnv('MEDIAMTX_PUBLISH_PASS', '');
      expect((await post(false)).status).toBe(200);
      expect(await column()).toBe(false);
    } finally {
      vi.stubEnv('MEDIAMTX_PUBLISH_PASS', PASS);
    }
  });

  t('switching video off while somebody sends disconnects the picture', async (k) => {
    const s = await person(k);
    const id = await show(k, s.id);
    vi.stubEnv('VIDEO_SENDERS', 'seller');
    const w = await h.whip(whipReq(id, s.cookie), sid(id));
    expect(w.status).toBe(201);
    const path = (await k.env.pool.query(`select ingest_path from show_secrets where show_id=$1`, [id])).rows[0].ingest_path as string;
    expect(media.live.has(`hp/${path}`)).toBe(true);
    await h.toggle(req(`/api/shows/${id}/video`, { body: { enabled: false }, cookie: s.cookie }), idCtx(id) as never);
    await vi.waitFor(() => expect(media.live.has(`hp/${path}`)).toBe(false));
    vi.stubEnv('VIDEO_SENDERS', '');
  });
});

describe('GET /api/streams/:showId/playback', () => {
  t('says nothing about video when the seller did not enable it, and never carries a host', async (k) => {
    const s = await person(k);
    const id = await show(k, s.id, { video: false });
    const res = await keep(await h.playback(req(`/api/streams/${id}/playback`), sid(id)));
    expect(PlaybackResponse.parse(await res.json())).toEqual({ enabled: false, live: false, hlsUrl: null });
    expect(res.headers.get('vercel-cdn-cache-control')).toBe('max-age=3');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  t('enabled but nobody sending: enabled true, live false, no url; then live with the url once a sender is on', async (k) => {
    const s = await person(k);
    const op = await person(k);
    vi.stubEnv('OPERATOR_WALLETS', op.a.wallet);
    const id = await show(k, s.id);
    const idle = PlaybackResponse.parse(await (await keep(await h.playback(req(`/api/streams/${id}/playback`), sid(id)))).json());
    expect(idle).toEqual({ enabled: true, live: false, hlsUrl: null });
    expect((await h.whip(whipReq(id, op.cookie), sid(id))).status).toBe(201);
    clearPlayback();
    const live = PlaybackResponse.parse(await (await keep(await h.playback(req(`/api/streams/${id}/playback`), sid(id)))).json());
    const seg = (await k.env.pool.query(`select ingest_path from show_secrets where show_id=$1`, [id])).rows[0].ingest_path as string;
    expect(live).toEqual({ enabled: true, live: true, hlsUrl: `${media.url}/hp/${seg}/index.m3u8` });
  });

  t('an ended show shows no video and disconnects a sender that is still there', async (k) => {
    const s = await person(k);
    const op = await person(k);
    vi.stubEnv('OPERATOR_WALLETS', op.a.wallet);
    const id = await show(k, s.id);
    await h.whip(whipReq(id, op.cookie), sid(id));
    await k.env.pool.query(`update shows set status='ended' where id=$1`, [id]);
    clearPlayback();
    const body = PlaybackResponse.parse(await (await h.playback(req(`/api/streams/${id}/playback`), sid(id))).json());
    expect(body).toEqual({ enabled: true, live: false, hlsUrl: null });
    const seg = (await k.env.pool.query(`select ingest_path from show_secrets where show_id=$1`, [id])).rows[0].ingest_path as string;
    await vi.waitFor(() => expect(media.live.has(`hp/${seg}`)).toBe(false));
  });

  t('is off when the feature is off or the settings are incomplete, and a bad or unknown id is a 404', async (k) => {
    const s = await person(k);
    const id = await show(k, s.id);
    vi.stubEnv('MEDIAMTX_PUBLISH_PASS', '');
    expect(await (await h.playback(req(`/api/streams/${id}/playback`), sid(id))).json()).toEqual({ enabled: false, live: false, hlsUrl: null });
    vi.stubEnv('MEDIAMTX_PUBLISH_PASS', PASS);
    clearPlayback();
    vi.stubEnv('FEATURE_VIDEO', 'false');
    clearFlagMemo();
    expect(await (await h.playback(req(`/api/streams/${id}/playback`), sid(id))).json()).toEqual({ enabled: false, live: false, hlsUrl: null });
    vi.stubEnv('FEATURE_VIDEO', 'true');
    clearFlagMemo();
    expect((await h.playback(req('/api/streams/nope/playback'), sid('nope'))).status).toBe(404);
    const none = '3f6c1f2e-9b0a-4f43-8a52-1d7a0c5e7b11';
    expect((await h.playback(req(`/api/streams/${none}/playback`), sid(none))).status).toBe(404);
  });
});

describe('POST /api/streams/:showId/whip', () => {
  t('an operator sends: the offer reaches the media server with the Basic credential, and the answer comes back with our own Location', async (k) => {
    const s = await person(k);
    const op = await person(k);
    vi.stubEnv('OPERATOR_WALLETS', op.a.wallet);
    const id = await show(k, s.id);
    media.seen.length = 0;
    const res = await keep(await h.whip(whipReq(id, op.cookie), sid(id)));
    expect(res.status).toBe(201);
    expect(res.headers.get('content-type')).toBe('application/sdp');
    expect(res.headers.get('location')).toMatch(new RegExp(`^/api/streams/${id}/whip/[0-9a-f-]{36}$`));
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await res.text()).startsWith('v=0')).toBe(true);
    const sent = media.seen.find((r) => r.method === 'POST')!;
    expect(sent.authorization).toBe(`Basic ${BASIC}`);
    expect(sent.contentType).toBe('application/sdp');
    expect(sent.body).toBe(OFFER);
    const seg = (await k.env.pool.query(`select ingest_path, publish_token from show_secrets where show_id=$1`, [id])).rows[0];
    expect(sent.path).toBe(`/hp/${seg.ingest_path}/whip`);
    expect(seg.ingest_path).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(seg.publish_token).toMatch(/^[A-Za-z0-9_-]{22}$/); // the unused NOT NULL column holds a random value, never the credential
    expect(seg.publish_token).not.toBe(seg.ingest_path);
  });

  t('every show gets its own random path and keeps it', async (k) => {
    const op = await person(k);
    vi.stubEnv('OPERATOR_WALLETS', op.a.wallet);
    const s = await person(k);
    const a = await show(k, s.id);
    const b = await show(k, s.id);
    media.seen.length = 0;
    for (const id of [a, b, a]) { await keep(await h.whip(whipReq(id, op.cookie, { ip: `10.7.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }), sid(id))); }
    const paths = media.seen.filter((r) => r.method === 'POST').map((r) => r.path);
    expect(paths[0]).toBe(paths[2]);
    expect(paths[0]).not.toBe(paths[1]);
    expect(paths.every((p) => p.startsWith('/hp/') && !p.startsWith('/live/'))).toBe(true);
    const rows = (await k.env.pool.query(`select count(*)::int as n from show_secrets where show_id = any($1)`, [[a, b]])).rows[0].n;
    expect(rows).toBe(2);
  });

  t('the house show has the fixed path and only an operator may send there, whatever VIDEO_SENDERS says', async (k) => {
    const op = await person(k);
    const seller = await person(k);
    vi.stubEnv('OPERATOR_WALLETS', op.a.wallet);
    vi.stubEnv('VIDEO_SENDERS', 'seller');
    const id = await show(k, seller.id, { isHouse: true });
    expect(await code(await h.whip(whipReq(id, seller.cookie), sid(id)))).toBe('not_seller');
    media.seen.length = 0;
    expect((await h.whip(whipReq(id, op.cookie), sid(id))).status).toBe(201);
    expect(media.seen.find((r) => r.method === 'POST')!.path).toBe('/hp/house/whip');
    expect((await k.env.pool.query(`select 1 from show_secrets where show_id=$1`, [id])).rows).toHaveLength(0);
    vi.stubEnv('VIDEO_SENDERS', '');
  });

  t('who may send: by default only an operator; the seller too with VIDEO_SENDERS=seller; a stranger never', async (k) => {
    const seller = await person(k);
    const stranger = await person(k);
    const id = await show(k, seller.id);
    expect(await code(await h.whip(whipReq(id, undefined), sid(id)))).toBe('unauthenticated');
    expect(await code(await h.whip(whipReq(id, seller.cookie), sid(id)))).toBe('not_seller');
    vi.stubEnv('VIDEO_SENDERS', 'seller');
    expect((await h.whip(whipReq(id, seller.cookie), sid(id))).status).toBe(201);
    expect(await code(await h.whip(whipReq(id, stranger.cookie), sid(id)))).toBe('not_seller');
    vi.stubEnv('VIDEO_SENDERS', '');
  });

  t('refuses the wrong content type, a body over 20 KB, a body without v=0, and a cross-origin post', async (k) => {
    const seller = await person(k);
    vi.stubEnv('OPERATOR_WALLETS', seller.a.wallet);
    const id = await show(k, seller.id);
    media.seen.length = 0;
    const bad = async (o: Parameters<typeof whipReq>[2]) => await code(await keep(await h.whip(whipReq(id, seller.cookie, { ip: `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ...o }), sid(id))));
    expect(await bad({ type: 'application/json' })).toBe('validation');
    expect(await bad({ type: 'application/sdp; charset=utf-8' })).toBe('validation');
    expect(await bad({ type: 'text/plain' })).toBe('validation');
    expect(await bad({ body: `v=0\r\n${'a=x\r\n'.repeat(5000)}` })).toBe('validation');
    expect(await bad({ body: 'hello' })).toBe('validation');
    expect(await bad({ body: '' })).toBe('validation');
    const cross = await h.whip(req(`/api/streams/${id}/whip`, { method: 'POST', body: OFFER, cookie: seller.cookie, headers: { 'content-type': 'application/sdp', origin: 'https://evil.example' } }), sid(id));
    expect(await code(cross)).toBe('forbidden');
    expect(media.seen.filter((r) => r.method === 'POST' && r.path.endsWith('/whip'))).toHaveLength(0); // nothing reached the media server
  });

  t('refuses a show without video, an ended show and a switched-off feature; an unknown or malformed id is a 404', async (k) => {
    const seller = await person(k);
    vi.stubEnv('OPERATOR_WALLETS', seller.a.wallet);
    const noVideo = await show(k, seller.id, { video: false });
    const ended = await show(k, seller.id, { status: 'ended' });
    expect(await code(await h.whip(whipReq(noVideo, seller.cookie), sid(noVideo)))).toBe('wrong_state');
    expect(await code(await h.whip(whipReq(ended, seller.cookie), sid(ended)))).toBe('wrong_state');
    const ok = await show(k, seller.id);
    vi.stubEnv('FEATURE_VIDEO', 'false');
    clearFlagMemo();
    const off = await h.whip(whipReq(ok, seller.cookie), sid(ok));
    expect(off.status).toBe(404);
    expect(await code(off)).toBe('feature_off');
    vi.stubEnv('FEATURE_VIDEO', 'true');
    clearFlagMemo();
    expect((await h.whip(whipReq('nope', seller.cookie), sid('nope'))).status).toBe(404);
  });

  t('every upstream failure is video_unavailable with none of the upstream text: failing server, redirect, bad answer, no session id, wrong credential', async (k) => {
    const seller = await person(k);
    vi.stubEnv('OPERATOR_WALLETS', seller.a.wallet);
    const id = await show(k, seller.id);
    for (const m of ['fail', 'redirect', 'badAnswer', 'noLocation'] as const) {
      media.mode.whip = m;
      const res = await keep(await h.whip(whipReq(id, seller.cookie, { ip: `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }), sid(id)));
      expect(res.status, m).toBe(503);
      const body = await res.json();
      expect(body.code).toBe('video_unavailable');
      expect(JSON.stringify(body)).not.toContain('secret upstream detail');
    }
    media.mode.whip = 'ok';
    vi.stubEnv('MEDIAMTX_PUBLISH_PASS', 'a-wrong-credential');
    expect(await code(await keep(await h.whip(whipReq(id, seller.cookie, { ip: '10.9.1.1' }), sid(id))))).toBe('video_unavailable');
    vi.stubEnv('MEDIAMTX_PUBLISH_PASS', PASS);
  });

  t('is video_unavailable (not a crash) when the media-server settings are incomplete', async (k) => {
    const seller = await person(k);
    vi.stubEnv('OPERATOR_WALLETS', seller.a.wallet);
    const id = await show(k, seller.id);
    vi.stubEnv('MEDIA_SERVER_URL', '');
    expect(await code(await h.whip(whipReq(id, seller.cookie), sid(id)))).toBe('video_unavailable');
    vi.stubEnv('MEDIA_SERVER_URL', `127.0.0.1:${media.port}`);
  });

  t('limits a wallet to 6 offers a minute', async (k) => {
    await resetLimits(k.env);
    const seller = await person(k);
    vi.stubEnv('OPERATOR_WALLETS', seller.a.wallet);
    const id = await show(k, seller.id);
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await keep(await h.whip(whipReq(id, seller.cookie, { ip: `10.10.${i}.1` }), sid(id)))).status);
    expect(statuses.slice(0, 6).every((s) => s === 201)).toBe(true);
    expect(statuses.slice(6)).toEqual([429, 429]);
  });
});

describe('DELETE /api/streams/:showId/whip/:sessionId', () => {
  t('ends the session on the show\'s own path with the credential, even after the show ended', async (k) => {
    const seller = await person(k);
    vi.stubEnv('OPERATOR_WALLETS', seller.a.wallet);
    const id = await show(k, seller.id);
    const post = await h.whip(whipReq(id, seller.cookie), sid(id));
    const session = post.headers.get('location')!.split('/').at(-1)!;
    await k.env.pool.query(`update shows set status='ended' where id=$1`, [id]);
    media.seen.length = 0;
    const res = await keep(await h.whipStop(req(`/api/streams/${id}/whip/${session}`, { method: 'DELETE', cookie: seller.cookie, headers: { 'content-type': 'application/json' } }), sidSession(id, session)));
    expect(res.status).toBe(204);
    const sent = media.seen.find((r) => r.method === 'DELETE')!;
    expect(sent.authorization).toBe(`Basic ${BASIC}`);
    expect(sent.path).toMatch(new RegExp(`^/hp/[A-Za-z0-9_-]{22}/whip/${session}$`));
  });

  t('refuses a manipulated session id before anything is sent, and a stranger', async (k) => {
    const seller = await person(k);
    const stranger = await person(k);
    vi.stubEnv('OPERATOR_WALLETS', seller.a.wallet);
    const id = await show(k, seller.id);
    media.seen.length = 0;
    for (const bad of ['..', 'x', '../../v3/paths/kick/hp/y', '3f6c1f2e-9b0a-4f43-8a52-1d7a0c5e7b1', 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz']) {
      const res = await h.whipStop(req(`/api/streams/${id}/whip/x`, { method: 'DELETE', cookie: seller.cookie, ip: `10.11.${Math.floor(Math.random() * 250)}.1` }), sidSession(id, bad));
      expect(await code(res), bad).toBe('validation');
    }
    expect(media.seen).toHaveLength(0);
    const good = '3f6c1f2e-9b0a-4f43-8a52-1d7a0c5e7b10';
    expect(await code(await h.whipStop(req(`/api/streams/${id}/whip/${good}`, { method: 'DELETE', cookie: stranger.cookie }), sidSession(id, good)))).toBe('not_seller');
    expect(await code(await h.whipStop(req(`/api/streams/${id}/whip/${good}`, { method: 'DELETE' }), sidSession(id, good)))).toBe('unauthenticated');
  });
});

describe('secrets', () => {
  t('the publish credential, the API key and the media host appear in no answer or header of this file (except the playback url, which is the point)', async () => {
    expect(answers.length).toBeGreaterThan(10);
    const blob = answers.join('\n----\n');
    for (const secret of [PASS, USER, KEY, BASIC, 'secret upstream detail']) expect(blob, secret).not.toContain(secret);
    const withoutPlaybackUrl = blob.replaceAll(new RegExp(`${media.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/hp/[A-Za-z0-9_-]+/index.m3u8`, 'g'), '');
    expect(withoutPlaybackUrl).not.toContain(`127.0.0.1:${media.port}`);
    expect(withoutPlaybackUrl).not.toMatch(/\/hp\/[A-Za-z0-9_-]{22}/); // no path either
  });
});
