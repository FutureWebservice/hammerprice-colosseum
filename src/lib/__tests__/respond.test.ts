import { describe, it, expect } from 'vitest';
import { ApiError } from '@/contracts/errors';
import { ErrorResponseSchema } from '@/contracts/errors';
import { cacheHeaders, fail, fromError, json, noContent } from '../http/respond';

describe('cache modes', () => {
  it('never lets the browser cache, and opts the CDN in only when asked', () => {
    expect(cacheHeaders('none')).toEqual({ 'Cache-Control': 'no-store' });
    expect(cacheHeaders({ cdnS: 1 })).toEqual({ 'Cache-Control': 'no-store', 'Vercel-CDN-Cache-Control': 'max-age=1' });
    expect(cacheHeaders({ cdnS: 0 })['Vercel-CDN-Cache-Control']).toBe('max-age=1');
  });

  it('never emits stale-while-revalidate', () => {
    for (const mode of ['none', { cdnS: 10 }] as const) {
      expect(JSON.stringify(cacheHeaders(mode))).not.toContain('stale-while-revalidate');
    }
  });

  it('builds JSON and 204 responses with those headers', async () => {
    const r = json({ a: 1 }, { cdnS: 5 });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/json');
    expect(r.headers.get('vercel-cdn-cache-control')).toBe('max-age=5');
    expect(await r.json()).toEqual({ a: 1 });
    const n = noContent();
    expect(n.status).toBe(204);
    expect(n.headers.get('cache-control')).toBe('no-store');
  });
});

describe('errors', () => {
  it('answers the contract shape with the contract status', async () => {
    const r = fail('bid_too_low', 'too low', { minNext: '125000000' });
    expect(r.status).toBe(409);
    expect(r.headers.get('vercel-cdn-cache-control')).toBeNull();
    expect(ErrorResponseSchema.parse(await r.json())).toMatchObject({ ok: false, code: 'bid_too_low', minNext: '125000000' });
  });

  it('sets Retry-After on rate limits', () => {
    const r = fail('rate_limited', 'slow down', { retryAfterS: 1.2 });
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('2');
  });

  it('maps an ApiError and rethrows everything else', () => {
    expect(fromError(new ApiError('not_found', 'no such lot')).status).toBe(404);
    expect(() => fromError(new Error('boom'))).toThrow('boom');
  });
});
