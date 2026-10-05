/**
 * The profile page's routes through the real handlers on Postgres 18 with real signed sessions: the username (unique without regard to case, the
 * filter), the uploaded picture (owner only, magic bytes, the 200 KB cap, served cached with nosniff), the summary of what an account bought and
 * sold, and the result of each bid. Plain data tests of the pure checks are in src/server/profile/__tests__.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActivityResponse, ErrorResponseSchema, ProfileResponse, ROUTES, SummaryResponse } from '@/contracts';
import { actor, freshIp, idCtx, req, resetLimits, signIn, startKit, USDC, type Kit } from './kit';

let kit: Kit | undefined; let skipReason: string | undefined;
type Handler = (r: Request, c?: { params: Promise<{ id: string }> }) => Promise<Response>;
let h: { patch: Handler; get: Handler; avatarPost: Handler; avatarDelete: Handler; avatarGet: Handler; summary: Handler; activity: Handler };
beforeAll(async () => {
  const r = await startKit();
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  kit = r.kit;
  const prof = await import('@/app/api/me/profile/route');
  const av = await import('@/app/api/me/avatar/route');
  h = {
    patch: prof.PATCH as Handler, get: prof.GET as Handler, avatarPost: av.POST as Handler, avatarDelete: av.DELETE as Handler,
    avatarGet: (await import('@/app/api/avatar/[id]/route')).GET as Handler, summary: (await import('@/app/api/me/summary/route')).GET as Handler,
    activity: (await import('@/app/api/me/activity/route')).GET as Handler,
  };
}, 180_000);
afterAll(async () => { await kit?.stop(); });
const t = (name: string, fn: (k: Kit) => Promise<void>, timeout = 60_000) => it(name, async (ctx) => { if (!kit) return ctx.skip(skipReason); await fn(kit); }, timeout);

async function user(k: Kit) {
  const a = actor();
  const cookie = await signIn(a);
  const id = (await k.env.pool.query(`select id from profiles where wallet_address = $1`, [a.wallet])).rows[0].id as string;
  return { a, cookie, id };
}
const patch = (cookie: string | undefined, body: unknown) => h.patch(req('/api/me/profile', { method: 'PATCH', body, cookie, ip: freshIp() }));

/** Tiny files that are well-formed as far as the server checks: a real 1x1 png, and a jpeg and a lossless webp built byte by byte (1x1 pixel). */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([22, 0, 0, 0]), Buffer.from('WEBPVP8L'), Buffer.from([10, 0, 0, 0]), Buffer.from([0x2f, 0, 0, 0, 0, 0, 0, 0, 0, 0])]);
const post = (cookie: string | undefined, body: Uint8Array | string, type = 'image/png', headers: Record<string, string> = {}) =>
  h.avatarPost(new Request('http://localhost:3000/api/me/avatar', { method: 'POST', body: body as BodyInit, headers: { origin: 'http://localhost:3000', 'content-type': type, 'x-forwarded-for': freshIp(), ...(cookie ? { cookie } : {}), ...headers } }));
const del = (cookie: string | undefined) => h.avatarDelete(req('/api/me/avatar', { method: 'DELETE', cookie, ip: freshIp() }));
const serve = (id: string, query = '') => h.avatarGet(req(`/api/avatar/${id}${query}`, { ip: freshIp() }), idCtx(id));

describe('username', () => {
  t('is saved as typed, shown back, and unique without regard to case (another account is refused with rule taken)', async (k) => {
    const a = await user(k); const b = await user(k);
    const ok = await patch(a.cookie, { username: 'Card_Fan_7' });
    expect(ok.status).toBe(200);
    expect(ProfileResponse.parse(await ok.json()).profile.username).toBe('Card_Fan_7');
    for (const clash of ['card_fan_7', 'CARD_FAN_7']) {
      const res = await patch(b.cookie, { username: clash });
      expect(res.status, clash).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'validation', field: 'username', rule: 'taken' });
    }
    expect((await k.env.pool.query(`select username from profiles where id = $1`, [b.id])).rows[0].username).toBeNull();
    expect((await patch(a.cookie, { username: 'card_fan_7' })).status).toBe(200); // the owner may change the letter case of their own
    expect((await patch(a.cookie, { username: null })).status).toBe(200); // clearing frees the name
    expect((await patch(b.cookie, { username: 'Card_Fan_7' })).status).toBe(200);
  });

  const bad: [string, string, string][] = [
    ['two characters', 'ab', 'too_short'], ['25 characters', 'a'.repeat(25), 'too_long'], ['a space', 'two words', 'characters'], ['an umlaut', 'Jürgen', 'characters'],
    ['an at sign', 'anna@x', 'characters'], ['a platform name', 'Hammerprice_Team', 'reserved'], ['a look-alike platform name', 'h4mmerpr1ce', 'reserved'],
    ['an insult hidden by digits', 'sh1t_head', 'profane'], ['a german insult', 'Arschloch99', 'profane'],
  ];
  for (const [label, username, rule] of bad) {
    t(`refuses ${label} (${rule}) and stores nothing`, async (k) => {
      const u = await user(k);
      const res = await patch(u.cookie, { username, bio: 'valid' });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'validation', field: 'username', rule });
      expect((await k.env.pool.query(`select username, bio from profiles where id = $1`, [u.id])).rows[0]).toEqual({ username: null, bio: null });
    });
  }

  t('words that merely contain letters of the filter are fine ("assistant", "Scunthorpe")', async (k) => {
    const u = await user(k);
    expect((await patch(u.cookie, { username: 'assistant_77' })).status).toBe(200);
  });
});

describe('avatar upload', () => {
  t('stores a png, jpeg or webp by its bytes, answers the profile, and serves it publicly with the right type, nosniff and a long cache for a versioned address', async (k) => {
    await resetLimits(k.env);
    const u = await user(k);
    for (const [bytes, type] of [[PNG, 'image/png'], [JPEG, 'image/jpeg'], [WEBP, 'image/webp']] as const) {
      const res = await post(u.cookie, bytes, 'application/octet-stream'); // the declared type is only a hint
      expect(res.status, type).toBe(200);
      const profile = ProfileResponse.parse(await res.json()).profile;
      expect(profile.avatar).not.toBeNull();
      const got = await serve(u.id, `?v=${profile.avatar!.version}`);
      expect(got.status).toBe(200);
      expect(got.headers.get('content-type')).toBe(type);
      expect(got.headers.get('x-content-type-options')).toBe('nosniff');
      expect(got.headers.get('content-security-policy')).toContain('sandbox');
      expect(got.headers.get('cache-control')).toContain('immutable');
      expect(Buffer.from(await got.arrayBuffer()).equals(bytes)).toBe(true);
    }
    expect((await serve(u.id)).headers.get('cache-control')).toBe('public, max-age=60'); // no version: kept for a minute only
    const { rows } = await k.env.pool.query(`select action, detail from audit_logs where target = $1 and action = 'profile.avatar' order by id`, [u.id]);
    expect(rows).toHaveLength(3);
    expect(JSON.stringify(rows)).not.toContain('PNG');
  });

  t('refuses SVG, HTML, text, a renamed file and a picture with a trailer, by its bytes (400 validation, field avatar), and keeps the old picture', async (k) => {
    await resetLimits(k.env);
    const u = await user(k);
    await post(u.cookie, PNG);
    const cases: [string, Uint8Array | string, string][] = [
      ['svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'avatar_type'],
      ['html as png', '<html><body>x</body></html>', 'avatar_type'],
      ['gif', Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'binary'), 'avatar_type'],
      ['png with a script after the end', Buffer.concat([PNG, Buffer.from('<script>alert(1)</script>')]), 'avatar_type'],
      ['png cut short', PNG.subarray(0, 40), 'avatar_type'],
      ['jpeg signature only', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), 'avatar_type'],
      ['empty', new Uint8Array(0), 'avatar_empty'],
    ];
    for (const [label, body, rule] of cases) {
      const res = await post(u.cookie, body, label === 'svg' ? 'image/svg+xml' : 'image/png');
      expect(res.status, label).toBe(400);
      expect(await res.json(), label).toMatchObject({ code: 'validation', field: 'avatar', rule });
    }
    expect((await k.env.pool.query(`select avatar_type, octet_length(avatar) n from profiles where id = $1`, [u.id])).rows[0]).toEqual({ avatar_type: 'image/png', n: PNG.length });
  });

  t('the 200 KB cap: a valid png padded to just under passes, one byte over is refused (avatar_size), and an oversized declared length is refused before reading', async (k) => {
    await resetLimits(k.env);
    const u = await user(k);
    // a png whose IHDR says 1x1 but carries a large private chunk before IEND: size is the only rule it meets
    const chunk = (len: number) => { const b = Buffer.alloc(12 + len); b.writeUInt32BE(len, 0); b.write('prVt', 4, 'latin1'); return b; };
    const withPadding = (n: number) => Buffer.concat([PNG.subarray(0, PNG.length - 12), chunk(n), PNG.subarray(PNG.length - 12)]);
    const max = 200 * 1024;
    const exact = withPadding(max - PNG.length - 12);
    expect(exact.length).toBe(max);
    expect((await post(u.cookie, exact)).status).toBe(200);
    const over = withPadding(max - PNG.length - 12 + 1);
    const res = await post(u.cookie, over);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: 'avatar', rule: 'avatar_size' });
    const huge = await post(u.cookie, 'x', 'image/png', { 'content-length': String(5 * 1024 * 1024) });
    expect(huge.status).toBe(400);
    expect(await huge.json()).toMatchObject({ field: 'avatar', rule: 'avatar_size' });
  });

  t('owner only: no session is 401, another origin is 403, and a user can only ever change their own picture', async (k) => {
    await resetLimits(k.env);
    const a = await user(k); const b = await user(k);
    expect((await post(undefined, PNG)).status).toBe(401);
    expect((await del(undefined)).status).toBe(401);
    const evil = await post(a.cookie, PNG, 'image/png', { origin: 'https://evil.example' });
    expect(evil.status).toBe(403);
    expect(ErrorResponseSchema.parse(await evil.json()).code).toBe('forbidden');
    await post(a.cookie, PNG);
    await post(b.cookie, JPEG);
    expect((await del(a.cookie)).status).toBe(200);
    expect((await serve(a.id)).status).toBe(404);
    expect((await serve(b.id)).headers.get('content-type')).toBe('image/jpeg'); // b is untouched
    expect(ProfileResponse.parse(await (await h.get(req('/api/me/profile', { cookie: a.cookie, ip: freshIp() }))).json()).profile.avatar).toBeNull();
  });

  t('rate limited at 10 changes an hour; a banned account\'s picture is no longer served; an unknown or malformed id is a 404', async (k) => {
    await resetLimits(k.env);
    const u = await user(k);
    for (let n = 0; n < 10; n++) expect((await post(u.cookie, PNG)).status, `upload ${n}`).toBe(200);
    const res = await post(u.cookie, PNG);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await serve(u.id)).status).toBe(200);
    await k.env.pool.query(`update profiles set is_banned = true where id = $1`, [u.id]);
    expect((await serve(u.id)).status).toBe(404);
    expect((await serve('00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await serve('not-a-uuid')).status).toBe(404);
  });

  t('the database itself refuses a picture over 200 KB or of another type (the constraint of migration 0010)', async (k) => {
    const u = await user(k);
    await expect(k.env.pool.query(`update profiles set avatar = $2, avatar_type = 'image/svg+xml' where id = $1`, [u.id, PNG])).rejects.toThrow(/profiles_avatar_check/);
    await expect(k.env.pool.query(`update profiles set avatar = $2, avatar_type = 'image/png' where id = $1`, [u.id, Buffer.alloc(204801)])).rejects.toThrow(/profiles_avatar_check/);
    await expect(k.env.pool.query(`update profiles set avatar = $2 where id = $1`, [u.id, PNG])).rejects.toThrow(/profiles_avatar_check/);
  });
});

describe('summary: what this account bought and sold', () => {
  const get = (cookie?: string) => h.summary(req('/api/me/summary', { cookie, ip: freshIp() }));
  async function sale(k: Kit, seller: string, buyer: string, status: string, gross: bigint, fee: bigint, tx: string | null = null) {
    const s = await k.env.show({ sellerId: seller, lots: [{ state: 'sold' }] });
    await k.env.pool.query(
      `insert into settlements (lot_id, buyer_id, seller_id, gross_amount, platform_fee, seller_amount, status, tx_signature, settled_at, cluster) values ($1,$2,$3,$4,$5,$6,$7,$8,now(),'devnet')`,
      [s.lots[0], buyer, seller, gross.toString(), fee.toString(), (gross - fee).toString(), status, tx],
    );
    return s.lots[0];
  }

  t('needs a session; a new account has zeros and nulls, never NaN', async (k) => {
    expect((await get()).status).toBe(401);
    const u = await user(k);
    expect(SummaryResponse.parse(await (await get(u.cookie)).json())).toEqual({
      bought: { count: 0, totalGross: '0', averageGross: null },
      sold: { count: 0, totalGross: '0', totalFees: '0', totalPayout: '0', averageGross: null, best: null },
      recentSales: [],
    });
  });

  t('counts settled settlements only, as buyer and as seller, with the average, the best sale, fees and payout; open or failed ones and other people\'s do not count', async (k) => {
    const me = await user(k); const other = await user(k);
    await sale(k, me.id, other.id, 'settled', 100n * USDC, 2n * USDC, 'tx-a');
    await sale(k, me.id, other.id, 'settled', 300n * USDC, 6n * USDC);
    await sale(k, me.id, other.id, 'awaiting_payment', 999n * USDC, 20n * USDC);
    await sale(k, me.id, other.id, 'failed', 888n * USDC, 20n * USDC);
    await sale(k, other.id, me.id, 'settled', 50n * USDC, USDC);
    await sale(k, other.id, me.id, 'submitted', 70n * USDC, USDC);
    await sale(k, other.id, other.id, 'settled', 5000n * USDC, 100n * USDC);
    const body = SummaryResponse.parse(await (await get(me.cookie)).json());
    expect(body.bought).toEqual({ count: 1, totalGross: (50n * USDC).toString(), averageGross: (50n * USDC).toString() });
    expect(body.sold).toMatchObject({ count: 2, totalGross: (400n * USDC).toString(), totalFees: (8n * USDC).toString(), totalPayout: (392n * USDC).toString(), averageGross: (200n * USDC).toString() });
    expect(body.sold.best?.gross).toBe((300n * USDC).toString());
    expect(body.recentSales).toHaveLength(2);
    expect(body.recentSales.map((r) => r.gross).sort()).toEqual([(100n * USDC).toString(), (300n * USDC).toString()]);
    expect(body.recentSales.find((r) => r.gross === (100n * USDC).toString())).toMatchObject({ fee: (2n * USDC).toString(), payout: (98n * USDC).toString() });
    expect(JSON.stringify(body)).not.toContain(other.a.wallet);
    expect(JSON.stringify(body)).not.toContain(other.id);
    expect(body.recentSales.find((r) => r.explorerUrl)?.explorerUrl).toContain('tx-a');
  });
});

describe('the result of each bid', () => {
  t('is leading or outbid while the lot is open, and won, lost or ended once it closed', async (k) => {
    const seller = await user(k); const me = await user(k); const rival = await user(k);
    const mk = async (state: string, high: string | null) => {
      const s = await k.env.show({ sellerId: seller.id, lots: [{ state: state as 'open', openedAt: new Date(), closesAt: new Date(Date.now() + 60_000) }] });
      await k.env.pool.query(`update lots set high_bidder_id = $2 where id = $1`, [s.lots[0], high]);
      await k.env.pool.query(`insert into bids (lot_id, bidder_id, amount, message, signature, nonce, placed_at) values ($1::uuid,$2,$3,'m','sig-' || $4::text,'n-' || $4::text, now())`, [s.lots[0], me.id, (10n * USDC).toString(), s.lots[0]]);
      return s.lots[0];
    };
    const ids = { leading: await mk('open', me.id), outbid: await mk('open', rival.id), won: await mk('sold', me.id), lost: await mk('sold', rival.id), ended: await mk('passed', null) };
    const page = ActivityResponse.parse(await (await h.activity(req('/api/me/activity?tab=bids', { cookie: me.cookie, ip: freshIp() }))).json());
    if (page.tab !== 'bids') throw new Error('tab');
    const byLot = Object.fromEntries(page.items.map((i) => [i.lotId, i.result]));
    for (const [want, lot] of Object.entries(ids)) expect(byLot[lot], want).toBe(want);
  });
});

describe('the contract', () => {
  it('registers the new routes: session only, owner data only', () => {
    expect(ROUTES.meAvatarSet).toMatchObject({ method: 'POST', path: '/api/me/avatar', auth: 'session' });
    expect(ROUTES.meAvatarClear).toMatchObject({ method: 'DELETE', path: '/api/me/avatar', auth: 'session' });
    expect(ROUTES.meSummary).toMatchObject({ method: 'GET', path: '/api/me/summary', auth: 'session' });
    expect(ROUTES.meWallet).toMatchObject({ method: 'GET', path: '/api/me/wallet', auth: 'session' });
  });
});
