import { afterEach, describe, expect, it } from 'vitest';
import { ROUTES, SellAssetsResponse, ShowListResponse, ReadinessResponse, type RouteKey } from '@/contracts/api';
import {
  PATHS, call, checkLotReadiness, controlLot, createShow, getSellAssets, getShow, goLive, listShows, mintTestCard, patchLot,
} from '../api';
import { claimFaucet, getActivity, getSettlement, releasePaddle } from '../../account/api';
import { fixture, stubFetch, unstub } from './fetchStub';

afterEach(unstub);

describe('PATHS stay in step with the contract', () => {
  it('every path equals the contract route it names', () => {
    for (const [key, p] of Object.entries(PATHS)) expect(ROUTES[key as RouteKey].path, key).toBe(p);
  });
});

describe('call', () => {
  it('returns the parsed body on success and sends JSON with the right method and cookies', async () => {
    const calls = stubFetch({ 'POST /api/x': { body: { hello: 1 } } });
    const r = await call('POST', '/api/x', { body: { a: 1 } });
    expect(r).toEqual({ ok: true, data: { hello: 1 } });
    expect(calls[0]).toEqual({ method: 'POST', url: '/api/x', body: { a: 1 } });
    const init = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0][1];
    expect(init.credentials).toBe('same-origin');
    expect(init.cache).toBe('no-store');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('builds the query string and skips undefined values', async () => {
    const calls = stubFetch({ 'GET /api/q': { body: {} } });
    await call('GET', '/api/q', { query: { a: '1', b: undefined, c: 'x y' } });
    expect(calls[0].url).toBe('/api/q?a=1&c=x+y');
  });

  it('answers 204 with no body', async () => {
    stubFetch({ 'POST /api/auth/logout': { status: 204 } });
    expect(await call('POST', '/api/auth/logout')).toEqual({ ok: true, data: undefined });
  });

  it('maps the contract error shape, including retryAfterS', async () => {
    stubFetch({ 'POST /api/devnet/faucet': { status: 429, body: fixture('error.rate-limited') } });
    const r = await claimFaucet();
    expect(r).toMatchObject({ ok: false, status: 429, code: 'rate_limited', retryAfterS: 2 });
  });

  it('falls back to the Retry-After header', async () => {
    stubFetch({ 'POST /api/devnet/faucet': { status: 429, body: { ok: false, code: 'rate_limited', reason: 'slow down' }, headers: { 'retry-after': '3600' } } });
    expect(await claimFaucet()).toMatchObject({ code: 'rate_limited', retryAfterS: 3600 });
  });

  it('turns a network failure into code "network" instead of throwing', async () => {
    stubFetch({ 'GET /api/me': new Error('offline') });
    expect(await call('GET', '/api/me')).toMatchObject({ ok: false, status: 0, code: 'network', reason: 'offline' });
  });

  it('tolerates a non-JSON error body (a bare 404 from a devnet-only route on mainnet)', async () => {
    stubFetch({ 'POST /api/devnet/mint-card': { status: 404 } });
    expect(await mintTestCard()).toMatchObject({ ok: false, status: 404, code: 'not_found' });
    stubFetch({ 'GET /api/me': { status: 401 } });
    expect(await call('GET', '/api/me')).toMatchObject({ code: 'unauthenticated' });
  });

  it('rethrows an abort the caller asked for', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    stubFetch({ 'GET /api/x': new DOMException('aborted', 'AbortError') });
    await expect(call('GET', '/api/x', { signal: ctrl.signal })).rejects.toThrow();
  });
});

describe('typed wrappers hit the contract routes with contract-valid bodies', () => {
  const id = '8a1b7c40-52de-4a6f-b3e1-0c9d2f4a6e11';

  it('getSellAssets returns a SellAssetsResponse', async () => {
    stubFetch({ 'GET /api/sell/assets': { body: fixture('sell-assets') } });
    const r = await getSellAssets();
    expect(r.ok && SellAssetsResponse.safeParse(r.data).success).toBe(true);
  });

  it('checkLotReadiness posts to the lot and returns the readiness', async () => {
    const calls = stubFetch({ [`POST /api/lots/${id}/readiness`]: { body: fixture('readiness-response') } });
    const r = await checkLotReadiness(id);
    expect(r.ok && ReadinessResponse.safeParse(r.data).success).toBe(true);
    expect(calls[0].body).toEqual({});
  });

  it('createShow posts the body unchanged', async () => {
    const body = fixture<Parameters<typeof createShow>[0]>('create-show-request');
    const calls = stubFetch({ 'POST /api/shows': { status: 201, body: fixture('show-detail') } });
    const r = await createShow(body);
    expect(r.ok).toBe(true);
    expect(calls[0].body).toEqual(body);
  });

  it('show management uses the show and lot ids in the path', async () => {
    const calls = stubFetch({
      [`GET /api/shows/${id}`]: { body: fixture('show-detail') },
      [`POST /api/shows/${id}/go-live`]: { body: {} },
      [`PATCH /api/lots/${id}`]: { body: {} },
      [`POST /api/lots/${id}/control`]: { body: {} },
    });
    await getShow(id);
    await goLive(id);
    await patchLot(id, { reserve: '100000000' });
    await controlLot(id, { action: 'extend', seconds: 30 });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET /api/shows/${id}`, `POST /api/shows/${id}/go-live`, `PATCH /api/lots/${id}`, `POST /api/lots/${id}/control`,
    ]);
    expect(calls[2].body).toEqual({ reserve: '100000000' });
    expect(calls[3].body).toEqual({ action: 'extend', seconds: 30 });
  });

  it('a path segment is encoded so a hostile id cannot add path parts', async () => {
    const calls = stubFetch({ 'GET /api/shows/a%2Fb%3Fc': { body: {} } });
    await getShow('a/b?c');
    expect(calls[0].url).toBe('/api/shows/a%2Fb%3Fc');
  });

  it('listShows sends the status and limit; the answer is a ShowListResponse', async () => {
    const calls = stubFetch({ 'GET /api/shows': { body: fixture('show-list') } });
    const r = await listShows('live', 10);
    expect(calls[0].url).toBe('/api/shows?status=live&limit=10');
    expect(r.ok && ShowListResponse.safeParse(r.data).success).toBe(true);
  });

  it('account wrappers: activity query, settlement, paddle release', async () => {
    const calls = stubFetch({
      'GET /api/me/activity': { body: { tab: 'bids', items: [], nextCursor: null } },
      [`GET /api/settlements/${id}`]: { body: fixture('settlement-awaiting') },
      [`DELETE /api/shows/${id}/paddle`]: { status: 204 },
    });
    await getActivity('bids', 'cur1');
    await getSettlement(id);
    expect(await releasePaddle(id)).toEqual({ ok: true, data: undefined });
    expect(calls[0].url).toBe('/api/me/activity?tab=bids&cursor=cur1');
  });
});

describe('server answers reach the page as data', () => {
  it('shows the wrong_state answer of a withdraw after a bid', async () => {
    const id = '8a1b7c40-52de-4a6f-b3e1-0c9d2f4a6e11';
    stubFetch({ [`POST /api/lots/${id}/control`]: { status: 409, body: { ok: false, code: 'wrong_state', reason: 'The lot already has a bid.' } } });
    const r = await controlLot(id, { action: 'withdraw' });
    expect(r).toMatchObject({ ok: false, status: 409, code: 'wrong_state', reason: 'The lot already has a bid.' });
  });
});

describe('listShows validates the answer', () => {
  it('an answer in the old format is an error state, not data the page can crash on', async () => {
    stubFetch({ 'GET /api/shows': { body: { shows: [{ id: 'x', title: 't', status: 'live', lotCount: 12 }] } } });
    const r = await listShows('live', 10);
    expect(r).toMatchObject({ ok: false, code: 'unknown' });
  });
});
