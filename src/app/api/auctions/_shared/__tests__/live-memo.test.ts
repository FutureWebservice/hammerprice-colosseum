/**
 * SEC load guard: GET /api/auctions/:id/live must not do database work per viewer. No database here: the engine is a counting fake.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const SHOW = '11111111-1111-4111-8111-111111111111';
const snapshot = { v: 1, serverNow: 1, show: { id: SHOW, isHouse: false, status: 'live' }, current: null, lots: [], events: [], lastEventId: 0 };

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

async function boot(memoMs: string) {
  vi.stubEnv('LIVE_SNAPSHOT_MEMO_MS', memoMs);
  vi.resetModules();
  const deps = await import('../deps');
  const getLiveSnapshot = vi.fn(async (id: string) => (id === SHOW ? (snapshot as never) : null));
  deps.setLiveServices({ auction: { getLiveSnapshot } as never });
  const { GET } = await import('../../../auctions/[id]/live/route');
  const call = (id: string, qs = '') => GET(new Request(`https://x.test/api/auctions/${id}/live${qs}`), { params: Promise.resolve({ id }) });
  return { getLiveSnapshot, call };
}

describe('live route load', () => {
  it('200 concurrent polls, half of them with a cache-busting query string, load the snapshot once', async () => {
    const { getLiveSnapshot, call } = await boot('500');
    const res = await Promise.all(Array.from({ length: 200 }, (_, i) => call(SHOW, i % 2 ? `?cb=${i}` : '')));
    expect(res.every((r) => r.status === 200)).toBe(true);
    expect(getLiveSnapshot).toHaveBeenCalledTimes(1);
    expect((await res[0]!.json()).show.id).toBe(SHOW);
    expect(res[0]!.headers.get('vercel-cdn-cache-control')).toBe('max-age=1');
    expect(res[0]!.headers.get('cache-control')).toBe('no-store');
  });

  it('an unknown show is a 404 and a malformed id never reaches the engine', async () => {
    const { getLiveSnapshot, call } = await boot('500');
    expect((await call('22222222-2222-4222-8222-222222222222')).status).toBe(404);
    expect((await call('not-a-uuid')).status).toBe(404);
    expect(getLiveSnapshot).toHaveBeenCalledTimes(1);
  });

  it('with the memo off (tests) every sequential poll is fresh', async () => {
    const { getLiveSnapshot, call } = await boot('0');
    await call(SHOW); await call(SHOW); await call(SHOW);
    expect(getLiveSnapshot).toHaveBeenCalledTimes(3);
  });
});
