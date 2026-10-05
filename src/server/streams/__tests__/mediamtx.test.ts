/**
 * The calls to the media server, against the local fake (fake-media.mjs): what the server sends (the Authorization header and
 * the API key, only toward the media server), how it reads the answers, and that no failure carries upstream text.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFakeMedia } from './fake-media.mjs';
import { isLive, isSessionId, kick, whipOffer, whipStop } from '../mediamtx';
import { videoConfig, type VideoConfig } from '../paths';

let media: Awaited<ReturnType<typeof startFakeMedia>>;
let cfg: VideoConfig;
const PATH = 'hp/AbCdEfGhIjKlMnOpQrStUv';
const API_KEY = 'fake-api-key';
const PUBLISH_USER = 'fake-user';
const PUBLISH_PASS = 'fake-pass-1234';
const OFFER = 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\n';

beforeAll(async () => {
  media = await startFakeMedia({ apiKey: API_KEY, publishUser: PUBLISH_USER, publishPass: PUBLISH_PASS });
  cfg = videoConfig({
    MEDIA_SERVER_URL: `127.0.0.1:${media.port}`, MEDIA_SERVER_WEBRTC_PORT: String(media.port), MEDIA_SERVER_API_URL: media.url,
    MEDIA_SERVER_API_KEY: API_KEY, MEDIAMTX_PUBLISH_USER: PUBLISH_USER, MEDIAMTX_PUBLISH_PASS: PUBLISH_PASS, VIDEO_ALLOW_INSECURE_TARGET: 'true',
  })!;
  expect(cfg).not.toBeNull();
});
afterAll(async () => { await media.close(); });
beforeEach(() => { media.live.clear(); media.sessions.clear(); media.seen.length = 0; media.mode.api = 'ok'; media.mode.whip = 'ok'; media.mode.hang = false; });

describe('isLive', () => {
  it('asks the control API with the key and says yes only for a path somebody is sending on', async () => {
    expect(await isLive(cfg, PATH)).toBe(false);
    media.live.add(PATH);
    expect(await isLive(cfg, PATH)).toBe(true);
    expect(media.seen.every((r) => r.apiKey === 'fake-api-key' && r.path.startsWith('/v3/paths/get/hp/'))).toBe(true);
  });

  it('falls back to the public manifest when the API fails: 200 means sending, 404 means nobody', async () => {
    media.mode.api = 'down';
    expect(await isLive(cfg, PATH)).toBe(false);
    media.live.add(PATH);
    // the fake's "down" mode answers 500 on the API only, so the manifest answers 200 for a live path
    expect(await isLive(cfg, PATH)).toBe(true);
    expect(media.seen.some((r) => r.path === `/${PATH}/index.m3u8`)).toBe(true);
  });

  it('uses the manifest when no API is configured', async () => {
    const noApi = { ...cfg, apiBase: null, apiKey: null };
    expect(await isLive(noApi, PATH)).toBe(false);
    media.live.add(PATH);
    expect(await isLive(noApi, PATH)).toBe(true);
    expect(media.seen.some((r) => r.path.startsWith('/v3/'))).toBe(false);
  });

  it('a 404 from the API is a definite "no" (the manifest is not asked)', async () => {
    expect(await isLive(cfg, PATH)).toBe(false);
    expect(media.seen.some((r) => r.path.endsWith('index.m3u8'))).toBe(false);
  });

  it('a wrong API key reads as "not live" and the manifest decides', async () => {
    media.live.add(PATH);
    expect(await isLive({ ...cfg, apiKey: 'wrong' }, PATH)).toBe(true); // 403 on the API, then the manifest says 200
  });

  it('times out instead of hanging (3 s per call) and then reports not live', async () => {
    media.mode.hang = true;
    const t0 = Date.now();
    expect(await isLive(cfg, PATH)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(8000);
  }, 15_000);

  it('never follows a redirect', async () => {
    const f = async () => new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1:1/x' } });
    expect(await isLive(cfg, PATH, f as typeof fetch)).toBe(false);
  });
});

describe('kick', () => {
  it('disconnects the sender on its own path and says whether it worked', async () => {
    media.live.add(PATH);
    expect(await kick(cfg, PATH)).toBe(true);
    expect(media.live.has(PATH)).toBe(false);
    expect(media.seen[0]).toMatchObject({ method: 'POST', path: `/v3/paths/kick/${PATH}`, apiKey: 'fake-api-key' });
    expect(await kick({ ...cfg, apiBase: null }, PATH)).toBe(false);
  });
});

describe('whipOffer', () => {
  it('forwards the offer with the Basic credential built here and returns the answer and the session id', async () => {
    const r = await whipOffer(cfg, PATH, OFFER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.answer.startsWith('v=0')).toBe(true);
    expect(isSessionId(r.sessionId)).toBe(true);
    const sent = media.seen[0]!;
    expect(sent).toMatchObject({ method: 'POST', path: `/${PATH}/whip`, contentType: 'application/sdp', body: OFFER });
    expect(sent.authorization).toBe(`Basic ${Buffer.from('fake-user:fake-pass-1234').toString('base64')}`);
    expect(media.live.has(PATH)).toBe(true);
  });

  it('a wrong credential, a failing server, a redirect, a missing session id and a bad answer are all a plain failure', async () => {
    expect(await whipOffer({ ...cfg, publishPass: 'wrong' }, PATH, OFFER)).toEqual({ ok: false });
    for (const m of ['fail', 'redirect', 'noLocation', 'badAnswer'] as const) {
      media.mode.whip = m;
      expect(await whipOffer(cfg, PATH, OFFER), m).toEqual({ ok: false });
    }
  });

  it('an unreachable server is a plain failure with no detail', async () => {
    expect(await whipOffer({ ...cfg, host: '127.0.0.1', webrtcPort: 1 }, PATH, OFFER)).toEqual({ ok: false });
  });
});

describe('whipStop', () => {
  it('ends the session on the same path with the same credential', async () => {
    const r = await whipOffer(cfg, PATH, OFFER);
    if (!r.ok) throw new Error('offer failed');
    media.seen.length = 0;
    expect(await whipStop(cfg, PATH, r.sessionId)).toBe(true);
    expect(media.seen[0]).toMatchObject({ method: 'DELETE', path: `/${PATH}/whip/${r.sessionId}` });
    expect(media.seen[0]!.authorization).toMatch(/^Basic /);
    expect(media.live.has(PATH)).toBe(false);
  });

  it('never sends anything for an id that is not a UUID (no way to steer the upstream address)', async () => {
    for (const bad of ['', '..', '../../x', 'a/b', '123', 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz']) expect(await whipStop(cfg, PATH, bad), bad).toBe(false);
    expect(media.seen).toHaveLength(0);
  });

  it('a session the server no longer knows counts as stopped', async () => {
    expect(await whipStop(cfg, PATH, '3f6c1f2e-9b0a-4f43-8a52-1d7a0c5e7b10')).toBe(true);
  });
});
