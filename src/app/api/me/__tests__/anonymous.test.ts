import { describe, expect, it } from 'vitest';
import { ROUTES } from '@/contracts';
import { GET } from '../route';

describe('GET /api/me without a session', () => {
  it('answers 204 with no body, never 401, so an anonymous visitor sees no failed request', async () => {
    const res = await GET(new Request('https://x.test/api/me'));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('treats a cookie that is not a valid session the same way', async () => {
    const res = await GET(new Request('https://x.test/api/me', { headers: { cookie: 'hp_session=abc.def' } }));
    expect(res.status).toBe(204);
  });

  it('is declared in the contract as session_optional with a 204 for anonymous', () => {
    expect(ROUTES.me.auth).toBe('session_optional');
    expect(ROUTES.me.anonymousStatus).toBe(204);
  });
});
