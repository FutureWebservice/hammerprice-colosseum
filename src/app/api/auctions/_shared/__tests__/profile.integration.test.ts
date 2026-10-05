/**
 * The profile editor's API (GET and PATCH /api/me/profile) through the real handlers on Postgres 18 with real signed sessions: sign-in required,
 * only your own row, every rule of the content checks as an HTTP answer, the rate limit, the audit trail, and where the name shows up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErrorResponseSchema, ProfileResponse, ROUTES, ShowDetail } from '@/contracts';
import { actor, freshIp, idCtx, req, resetLimits, signIn, startKit, type Kit } from './kit';

let kit: Kit | undefined; let skipReason: string | undefined;
type Handler = (r: Request, c?: { params: Promise<{ id: string }> }) => Promise<Response>;
let h: { get: Handler; patch: Handler; show: Handler };
beforeAll(async () => {
  const r = await startKit();
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  kit = r.kit;
  const mod = await import('@/app/api/me/profile/route');
  h = { get: mod.GET as Handler, patch: mod.PATCH as Handler, show: (await import('@/app/api/shows/[id]/route')).GET as Handler };
}, 180_000);
afterAll(async () => { await kit?.stop(); });
const t = (name: string, fn: (k: Kit) => Promise<void>, timeout = 60_000) => it(name, async (ctx) => { if (!kit) return ctx.skip(skipReason); await fn(kit); }, timeout);

/** A signed-in user: cookie plus the profile id the session maps to. */
async function user(k: Kit) {
  const a = actor();
  const cookie = await signIn(a);
  const id = (await k.env.pool.query(`select id from profiles where wallet_address = $1`, [a.wallet])).rows[0].id as string;
  return { a, cookie, id };
}
const patch = (cookie: string | undefined, body: unknown, over: { headers?: Record<string, string> } = {}) => h.patch(req('/api/me/profile', { method: 'PATCH', body, cookie, ip: freshIp(), ...over }));
const get = (cookie?: string) => h.get(req('/api/me/profile', { cookie, ip: freshIp() }));
const row = async (k: Kit, id: string) => (await k.env.pool.query(`select display_name, bio, avatar_url, updated_at from profiles where id = $1`, [id])).rows[0];
const bodyOf = async (res: Response) => (await res.json()) as Record<string, unknown>;
const GOOD_AVATAR = 'https://d1abc123.cloudfront.net/me/anna.png';

describe('reading', () => {
  t('needs a signed-in session (401), and a new profile is empty', async (k) => {
    const none = await get();
    expect(none.status).toBe(401);
    expect(ErrorResponseSchema.parse(await none.json()).code).toBe('unauthenticated');
    const u = await user(k);
    const res = await get(u.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(ProfileResponse.parse(await res.json())).toMatchObject({ profile: { id: u.id, username: null, displayName: null, bio: null, avatarUrl: null, avatar: null, strikes: 0 } });
  });

  t('a banned account is refused (403 banned), as everywhere else', async (k) => {
    const u = await user(k);
    await k.env.pool.query(`update profiles set is_banned = true where id = $1`, [u.id]);
    const res = await get(u.cookie);
    expect(res.status).toBe(403);
    expect(ErrorResponseSchema.parse(await res.json()).code).toBe('banned');
  });
});

describe('writing', () => {
  t('saves the three fields, answers the cleaned profile, and a later read returns the same', async (k) => {
    const u = await user(k);
    const before = (await row(k, u.id)).updated_at as Date;
    await new Promise((r) => setTimeout(r, 5));
    const res = await patch(u.cookie, { displayName: '  Anna   Müller ', bio: 'Collecting graded cards.\nPSA only.', avatarUrl: GOOD_AVATAR });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const want = { profile: { displayName: 'Anna Müller', bio: 'Collecting graded cards. PSA only.', avatarUrl: GOOD_AVATAR } };
    expect(ProfileResponse.parse(await res.json())).toMatchObject(want);
    expect(ProfileResponse.parse(await (await get(u.cookie)).json())).toMatchObject(want);
    const r = await row(k, u.id);
    expect(r).toMatchObject({ display_name: 'Anna Müller', bio: 'Collecting graded cards. PSA only.', avatar_url: GOOD_AVATAR });
    expect((r.updated_at as Date).getTime()).toBeGreaterThan(before.getTime());
  });

  t('removes control, bidi and zero-width characters from what it stores', async (k) => {
    const u = await user(k);
    const res = await patch(u.cookie, { displayName: '‮An​na\u0000', bio: 'he​llo‮' });
    expect(ProfileResponse.parse(await res.json()).profile).toMatchObject({ displayName: 'Anna', bio: 'hello' });
    const raw = await row(k, u.id);
    expect(`${raw.display_name}${raw.bio}`).not.toMatch(/[\u0000-\u001f​-‏‪-‮⁦-⁩﻿]/);
  });

  t('a partial update leaves the other fields alone; null or an empty string clears a field', async (k) => {
    const u = await user(k);
    await patch(u.cookie, { displayName: 'Anna', bio: 'About me', avatarUrl: GOOD_AVATAR });
    expect(ProfileResponse.parse(await (await patch(u.cookie, { bio: 'Changed' })).json()).profile).toMatchObject({ displayName: 'Anna', bio: 'Changed', avatarUrl: GOOD_AVATAR });
    expect(ProfileResponse.parse(await (await patch(u.cookie, { avatarUrl: null })).json()).profile).toMatchObject({ displayName: 'Anna', bio: 'Changed', avatarUrl: null });
    expect(ProfileResponse.parse(await (await patch(u.cookie, { displayName: '', bio: '   ' })).json()).profile).toMatchObject({ displayName: null, bio: null, avatarUrl: null });
    expect(await row(k, u.id)).toMatchObject({ display_name: null, bio: null, avatar_url: null });
  });

  t('only ever your own row: another user is untouched, and an id or another column in the body is refused', async (k) => {
    const me = await user(k); const other = await user(k);
    await patch(other.cookie, { displayName: 'Other Person' });
    await patch(me.cookie, { displayName: 'Me Myself' });
    expect((await row(k, other.id)).display_name).toBe('Other Person');
    for (const extra of [{ id: other.id }, { profileId: other.id }, { strikes: 0 }, { walletAddress: other.a.wallet }, { isSeller: true }, { isBanned: false }]) {
      const res = await patch(me.cookie, { displayName: 'Me Again', ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    expect((await row(k, me.id)).display_name).toBe('Me Myself');
    expect((await row(k, other.id)).display_name).toBe('Other Person');
  });

  t('records that a profile changed in the audit log, with the field names and never the content', async (k) => {
    const u = await user(k);
    await patch(u.cookie, { displayName: 'Secret Name', bio: 'Private words' });
    const { rows } = await k.env.pool.query(`select action, actor_wallet, detail from audit_logs where target = $1 and action = 'profile.update'`, [u.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'profile.update', actor_wallet: u.a.wallet, detail: { fields: ['displayName', 'bio'] } });
    expect(JSON.stringify(rows)).not.toContain('Secret Name');
    expect(JSON.stringify(rows)).not.toContain('Private words');
  });
});

describe('refusals', () => {
  const cases: [string, Record<string, string>, string, string][] = [
    ['a link in the name', { displayName: 'visit shop.com' }, 'displayName', 'link'],
    ['a link in the bio', { bio: 'see https://example.com now' }, 'bio', 'link'],
    ['an e-mail address', { displayName: 'anna@example.org' }, 'displayName', 'contact_data'],
    ['a phone number in the bio', { bio: 'call +49 170 1234567' }, 'bio', 'contact_data'],
    ['a platform name', { displayName: 'Hammerprice Support' }, 'displayName', 'reserved'],
    ['a look-alike platform name', { displayName: 'H4mmerpr1ce' }, 'displayName', 'reserved'],
    ['markup characters', { displayName: 'Anna <b>' }, 'displayName', 'characters'],
    ['a name that is too short', { displayName: 'A' }, 'displayName', 'too_short'],
    ['a name that is too long', { displayName: 'abcdefgh '.repeat(5) }, 'displayName', 'too_long'],
    ['a bio that is too long', { bio: 'word '.repeat(60) }, 'bio', 'too_long'],
    ['a picture over http', { avatarUrl: 'http://d1.cloudfront.net/a.png' }, 'avatarUrl', 'avatar_https'],
    ['a picture on another host', { avatarUrl: 'https://example.com/a.png' }, 'avatarUrl', 'avatar_host'],
    ['a javascript address', { avatarUrl: 'javascript:alert(1)' }, 'avatarUrl', 'avatar_https'],
    ['a picture address with credentials', { avatarUrl: 'https://user:pw@d1.cloudfront.net/a.png' }, 'avatarUrl', 'avatar_invalid'],
  ];
  for (const [label, body, field, rule] of cases) {
    t(`${label}: 400 validation naming the field and the rule, and nothing is stored (not even a valid field sent with it)`, async (k) => {
      const u = await user(k);
      await patch(u.cookie, { displayName: 'Kept Name' });
      const res = await patch(u.cookie, { bio: 'valid bio', ...body });
      expect(res.status).toBe(400);
      const b = await bodyOf(res);
      expect(b).toMatchObject({ ok: false, code: 'validation', field, rule });
      expect(typeof b.reason).toBe('string');
      expect(await row(k, u.id)).toMatchObject({ display_name: 'Kept Name', bio: null });
    });
  }

  t('an empty body, unknown fields, wrong types and a body that is not JSON are 400 validation', async (k) => {
    const u = await user(k);
    for (const bad of [{}, { nope: 1 }, { displayName: 7 }, { bio: ['a'] }, { displayName: 'x'.repeat(201) }, { bio: 'x'.repeat(1001) }, 'not json at all']) {
      const res = await patch(u.cookie, bad);
      expect(res.status, JSON.stringify(bad).slice(0, 50)).toBe(400);
      expect(ErrorResponseSchema.parse(await res.json()).code).toBe('validation');
    }
  });

  t('401 without a session, 403 from another origin, 400 for the wrong content type', async (k) => {
    const u = await user(k);
    const anon = await patch(undefined, { displayName: 'Anna' });
    expect(anon.status).toBe(401);
    const evil = await patch(u.cookie, { displayName: 'Anna' }, { headers: { origin: 'https://evil.example' } });
    expect(evil.status).toBe(403);
    expect(ErrorResponseSchema.parse(await evil.json()).code).toBe('forbidden');
    const text = await patch(u.cookie, 'displayName=Anna', { headers: { 'content-type': 'text/plain' } });
    expect(text.status).toBe(400);
    expect((await row(k, u.id)).display_name).toBeNull();
  });

  t('rate limited: 10 changes an hour, the eleventh is a 429 with Retry-After', async (k) => {
    await resetLimits(k.env);
    const u = await user(k);
    for (let n = 0; n < 10; n++) expect((await patch(u.cookie, { displayName: `Name ${n}` })).status, `change ${n}`).toBe(200);
    const res = await patch(u.cookie, { displayName: 'One too many' });
    expect(res.status).toBe(429);
    expect(ErrorResponseSchema.parse(await res.json()).code).toBe('rate_limited');
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await row(k, u.id)).display_name).toBe('Name 9');
    expect((await get(u.cookie)).status).toBe(200); // reading is not limited by the write limit
  });
});

describe('where the name shows', () => {
  t('the seller\'s display name is on the catalogue of their room; no name or the house show says nothing', async (k) => {
    const u = await user(k);
    const mine = await k.env.show({ sellerId: u.id, lots: [{ state: 'open', openedAt: new Date(), closesAt: new Date(Date.now() + 60_000) }] });
    const read = async (id: string) => ShowDetail.parse(await (await h.show(req(`/api/shows/${id}`), idCtx(id))).json()).show;
    expect((await read(mine.id)).sellerName).toBeNull(); // no name set yet
    await patch(u.cookie, { displayName: 'Anna Cards' });
    expect((await read(mine.id)).sellerName).toBe('Anna Cards');
    const house = await k.env.show({ sellerId: u.id, isHouse: true, lots: [{ state: 'open', openedAt: new Date(), closesAt: new Date(Date.now() + 60_000) }] });
    expect((await read(house.id)).sellerName).toBeNull(); // the house room is the platform's, whoever runs it
    await patch(u.cookie, { displayName: null });
    expect((await read(mine.id)).sellerName).toBeNull();
  });

  t('the name never reaches the bid log, the live snapshot or the feed: bids stay under the bidding number', async (k) => {
    const seller = await user(k); const bidder = await user(k);
    await patch(bidder.cookie, { displayName: 'Visible Vera' });
    const s = await k.env.show({ sellerId: seller.id, lots: [{ state: 'open', openedAt: new Date(), closesAt: new Date(Date.now() + 60_000) }] });
    const p = await k.env.paddle(s.id, bidder.id);
    const placed = await k.env.svc.placeBid({ lotId: s.lots[0], amount: 50_000_000n, bidderProfileId: bidder.id, bidderWallet: bidder.a.wallet, paddleId: p.id, via: 'wallet', message: 'm', signature: 'sig', nonce: 'n1', fundsBalance: 10n ** 12n });
    expect(placed.ok).toBe(true);
    const snap = JSON.stringify(await k.env.svc.getLiveSnapshot(s.id));
    expect(snap).not.toContain('Visible Vera');
    expect(snap).toContain(`"paddle":${p.number}`);
    expect(JSON.stringify(await k.env.events(s.id))).not.toContain('Visible Vera');
  });
});

describe('the contract', () => {
  it('registers GET and PATCH on /api/me/profile, session only, with a limit named for the write', () => {
    expect(ROUTES.meProfile).toMatchObject({ method: 'GET', path: '/api/me/profile', auth: 'session', status: 200 });
    expect(ROUTES.meProfileUpdate).toMatchObject({ method: 'PATCH', path: '/api/me/profile', auth: 'session', status: 200, limit: '10/h per wallet' });
  });
});
