/**
 * The waiting list route and the admin panel over a REAL Postgres (embedded): who gets in (admin wallets only, 404 for everyone else on every
 * route and page), what an admin sees, and the three writes with their audit rows. Sessions are real signed cookies.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { startTestPg, type TestPg } from '@/db/__tests__/pg-harness';
import { ctx, request, signIn } from '@/server/settlement/__tests__/routekit';

// The pages read the cookie through next/headers and answer 404 through next/navigation; outside a request both need a stand-in.
let pageCookie = '';
vi.mock('next/headers', () => ({ cookies: async () => ({ toString: () => pageCookie }) }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NEXT_NOT_FOUND'); } }));

let t: TestPg | undefined, skipReason: string | undefined;
let db: typeof import('@/db').db, schema: typeof import('@/db').schema;
type Handler = (req: Request, c?: { params: Promise<Record<string, string>> }) => Promise<Response>;
let R: { section: Handler; csv: Handler; wlDelete: Handler; reject: Handler; cancel: Handler; join: Handler };
let admin: Awaited<ReturnType<typeof signIn>>, user: Awaited<ReturnType<typeof signIn>>, seller: Awaited<ReturnType<typeof signIn>>;
let ids: { show: string; lot: string; msg: string; entry: string };

beforeAll(async () => {
  const r = await startTestPg({ poolMax: 10 });
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  t = r.pg;
  const adminKp = Keypair.generate();
  vi.stubEnv('DATABASE_URL', t.url);
  vi.stubEnv('SESSION_SECRET', 'integration-secret-integration-secret-01');
  vi.stubEnv('ADMIN_WALLETS', ` ${adminKp.publicKey.toBase58()} `);
  ({ db, schema } = await import('@/db'));
  R = {
    section: (await import('../[section]/route')).GET as Handler,
    csv: (await import('../waitlist/export/route')).GET as Handler,
    wlDelete: (await import('../waitlist/delete/route')).POST as Handler,
    reject: (await import('../chat/reject/route')).POST as Handler,
    cancel: (await import('../shows/cancel/route')).POST as Handler,
    join: (await import('../../waitlist/route')).POST as Handler,
  };
  admin = await signIn(adminKp);
  user = await signIn(Keypair.generate());
  seller = await signIn(Keypair.generate());
}, 120_000);
afterAll(async () => {
  await (globalThis as { __pool?: { end(): Promise<void> } }).__pool?.end().catch(() => {});
  vi.unstubAllEnvs();
  await t?.pool.end().catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  await t?.stop();
});
beforeEach(async () => {
  if (!t) return;
  for (const table of [schema.chatReports, schema.chatMessages, schema.bids, schema.settlements, schema.lots, schema.shows, schema.waitlist, schema.auditLogs, schema.rateLimits]) await db.delete(table);
  const [show] = await db.insert(schema.shows).values({ sellerId: seller.profileId, title: 'Sunday Slabs' }).returning({ id: schema.shows.id });
  const [lot] = await db.insert(schema.lots).values({ showId: show!.id, sellerId: seller.profileId, lotNumber: 1, mintAddress: 'MintAddr1111111111111111111111111111111111', nftStandard: 'core', name: 'Charizard 1st Edition', increment: 1_000_000n, openingPrice: 5_000_000n, highBid: 12_500_000n, highBidderId: user.profileId }).returning({ id: schema.lots.id });
  await db.insert(schema.bids).values({ lotId: lot!.id, bidderId: user.profileId, amount: 12_500_000n, signature: 's', message: 'm', nonce: 'n1' });
  const [msg] = await db.insert(schema.chatMessages).values({ showId: show!.id, authorId: user.profileId, body: 'buy my coins', status: 'pending' }).returning({ id: schema.chatMessages.id });
  await db.insert(schema.chatReports).values({ messageId: msg!.id, reporterId: seller.profileId, reason: 'spam' });
  const [entry] = await db.insert(schema.waitlist).values({ email: 'ada@example.com', locale: 'de' }).returning({ id: schema.waitlist.id });
  ids = { show: show!.id, lot: lot!.id, msg: msg!.id, entry: entry!.id };
});
const it_ = (name: string, fn: () => Promise<void> | void, timeout = 30_000) => it(name, async (c) => { if (!t) return c.skip(skipReason); await fn(); }, timeout);

const SECTIONS = ['overview', 'rooms', 'lots', 'history', 'users', 'cards', 'chats', 'waitlist'];
const get = (section: string, cookie?: string, qs = '') => R.section(request('GET', `/api/admin/${section}${qs}`, { cookie }), ctx({ section }));
const post = (h: Handler, path: string, body: unknown, cookie?: string) => h(request('POST', path, { cookie, body }));
const auditActions = async () => (await db.select().from(schema.auditLogs)).map((a) => a.action).sort();

describe('who gets in', () => {
  it_('every admin route is 404 for a visitor without a session and for a signed-in wallet that is not an admin', async () => {
    for (const cookie of [undefined, user.cookie, seller.cookie]) {
      for (const s of [...SECTIONS, 'nonsense']) {
        const res = await get(s, cookie);
        expect(res.status, `${s} ${cookie ? 'user' : 'anonymous'}`).toBe(404);
        expect(await res.json()).toMatchObject({ ok: false, code: 'not_found' });
      }
      expect((await R.csv(request('GET', '/api/admin/waitlist/export', { cookie }))).status).toBe(404);
      expect((await post(R.wlDelete, '/api/admin/waitlist/delete', { id: ids.entry }, cookie)).status).toBe(404);
      expect((await post(R.reject, '/api/admin/chat/reject', { id: ids.msg }, cookie)).status).toBe(404);
      expect((await post(R.cancel, '/api/admin/shows/cancel', { id: ids.show }, cookie)).status).toBe(404);
    }
    // nothing happened
    expect((await db.select().from(schema.waitlist)).length).toBe(1);
    expect((await db.select().from(schema.chatMessages))[0]!.status).toBe('pending');
    expect((await db.select().from(schema.shows))[0]!.status).toBe('scheduled');
  });

  it_('a forged or tampered session is 404 too', async () => {
    const tampered = admin.cookie.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    expect((await get('overview', tampered)).status).toBe(404);
  });

  it_('the pages answer 404 to non-admins (layout and page) and render for an admin', async () => {
    const { adminPage } = await import('@/server/admin/page');
    const AdminLayout = (await import('@/app/[locale]/admin/layout')).default;
    const props = { params: Promise.resolve({ locale: 'en' }), searchParams: Promise.resolve({}) };
    for (const cookie of ['', user.cookie]) {
      pageCookie = cookie;
      await expect(adminPage('waitlist', props)).rejects.toThrow('NEXT_NOT_FOUND');
      await expect(AdminLayout({ children: null, params: props.params })).rejects.toThrow('NEXT_NOT_FOUND');
    }
    pageCookie = admin.cookie;
    vi.stubGlobal('React', await import('react')); // the JSX of the layout is compiled for the classic runtime under vitest
    const { data } = await adminPage('waitlist', props);
    expect(data.total).toBe(1);
    await expect(AdminLayout({ children: null, params: props.params })).resolves.toBeTruthy();
  });

  it_('ADMIN_WALLETS wins; without it OPERATOR_WALLETS decides', async () => {
    const { adminWallets } = await import('@/server/admin/access');
    expect(adminWallets({ ADMIN_WALLETS: 'a, b', OPERATOR_WALLETS: 'c' })).toEqual(['a', 'b']);
    expect(adminWallets({ ADMIN_WALLETS: ' ', OPERATOR_WALLETS: 'c,d' })).toEqual(['c', 'd']);
    expect(adminWallets({})).toEqual([]);
  });
});

describe('what an admin sees', () => {
  it_('all eight sections answer with their table, and unknown sections are 404', async () => {
    for (const s of SECTIONS) {
      const res = await get(s, admin.cookie);
      expect(res.status, s).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = await res.json();
      expect(body).toMatchObject({ key: s, page: 1, pageSize: 50 });
      expect(body.rows.every((r: unknown[]) => r.length === body.columns.length), s).toBe(true);
    }
    expect((await get('nonsense', admin.cookie)).status).toBe(404);
  });

  it_('the overview counts what is there', async () => {
    const rows = (await (await get('overview', admin.cookie)).json()).rows as [string, string | number][];
    const by = Object.fromEntries(rows);
    expect(by['Waiting list entries']).toBe(1);
    expect(by['Bids']).toBe(1);
    expect(by['Lots']).toBe(1);
    expect(by['Shows scheduled']).toBe(1);
    expect(by['Chat messages waiting for approval']).toBe(1);
    expect(by['AI calls today (UTC)']).toBe(0);
  });

  it_('the overview also carries the capacity numbers: kept house shows, event and AI rows, and the database size', async () => {
    const by = Object.fromEntries((await (await get('overview', admin.cookie)).json()).rows as [string, string | number][]);
    expect(typeof by['Show events (rows)']).toBe('number');
    expect(typeof by['House (demo) shows kept']).toBe('number');
    expect(typeof by['AI usage rows']).toBe('number');
    expect(by['House rollover (last ok / last error / next retry)']).toBe('- / - / -'); // nothing has run in this database
    const sizeKey = Object.keys(by).find((k) => k.startsWith('Database size (MB'))!;
    expect(by[sizeKey]).toBeGreaterThan(0);
  });

  it_('rooms, lots, history, users, cards and chats show the seeded rows, searchable', async () => {
    const rooms = await (await get('rooms', admin.cookie)).json();
    expect(rooms.rows[0][0]).toMatchObject({ text: 'Sunday Slabs', href: `/en/room/${ids.show}` });
    expect(rooms.rows[0][4]).toBe(1);
    expect(rooms.rows[0][7]).toMatchObject({ action: 'show.cancel', id: ids.show });
    expect((await (await get('rooms', admin.cookie, '?q=nomatch')).json()).total).toBe(0);
    expect((await (await get('rooms', admin.cookie, `?q=${seller.wallet.slice(0, 8)}`)).json()).total).toBe(1);

    const lots = await (await get('lots', admin.cookie)).json();
    expect(lots.rows[0].slice(2, 5)).toEqual(['Charizard 1st Edition', 'catalogued', '12.5 USDC']);
    expect(lots.rows[0][5]).toMatchObject({ title: user.wallet });

    expect((await (await get('history', admin.cookie, '?tab=bids')).json()).rows[0][3]).toBe('12.5 USDC');
    expect((await (await get('history', admin.cookie, '?tab=audit')).json()).tab).toBe('audit');

    const users = await (await get('users', admin.cookie)).json();
    const mine = users.rows.find((r: unknown[]) => r[0] === user.wallet);
    expect(mine[6]).toBe(1); // bids
    expect((await (await get('users', admin.cookie, `?q=${user.wallet.slice(0, 10)}`)).json()).total).toBe(1);

    const cards = await (await get('cards', admin.cookie)).json();
    expect(cards.rows[0][0]).toBe('Charizard 1st Edition');
    expect(cards.rows[0][3]).toMatchObject({ title: seller.wallet }); // not settled: still the seller's

    const chats = await (await get('chats', admin.cookie, '?tab=reported')).json();
    expect(chats.rows).toHaveLength(1);
    expect(chats.rows[0][4]).toBe(1);
    expect((await (await get('chats', admin.cookie, '?tab=approved')).json()).total).toBe(0);
  });

  it_('pages hold at most 50 rows and the page number moves the window', async () => {
    await db.insert(schema.waitlist).values(Array.from({ length: 60 }, (_, i) => ({ email: `p${i}@example.com`, locale: 'en' })));
    const p1 = await (await get('waitlist', admin.cookie)).json();
    const p2 = await (await get('waitlist', admin.cookie, '?page=2')).json();
    expect([p1.total, p1.rows.length, p2.rows.length]).toEqual([61, 50, 11]);
    expect((await (await get('waitlist', admin.cookie, '?page=-3')).json()).page).toBe(1);
    expect((await (await get('waitlist', admin.cookie, '?q=p1')).json()).total).toBe(11);
  });

  it_('a search with SQL wildcards is taken literally', async () => {
    expect((await (await get('waitlist', admin.cookie, '?q=%25')).json()).total).toBe(0);
  });
});

describe('the three writes', () => {
  it_('delete a waiting list entry: gone, audited by id only', async () => {
    const res = await post(R.wlDelete, '/api/admin/waitlist/delete', { id: ids.entry }, admin.cookie);
    expect(res.status).toBe(200);
    expect(await db.select().from(schema.waitlist)).toHaveLength(0);
    const log = (await db.select().from(schema.auditLogs))[0]!;
    expect(log).toMatchObject({ action: 'admin.waitlist.delete', actorWallet: admin.wallet, target: ids.entry });
    expect(JSON.stringify(log)).not.toContain('ada@example.com');
    expect((await post(R.wlDelete, '/api/admin/waitlist/delete', { id: ids.entry }, admin.cookie)).status).toBe(404); // already gone
    expect((await post(R.wlDelete, '/api/admin/waitlist/delete', { id: 'nope' }, admin.cookie)).status).toBe(404);
  });

  it_('reject a chat message through the chat service: hidden, its report actioned, both audit rows', async () => {
    expect((await post(R.reject, '/api/admin/chat/reject', { id: ids.msg }, admin.cookie)).status).toBe(200);
    const [m] = await db.select().from(schema.chatMessages);
    expect(m).toMatchObject({ status: 'rejected', hiddenReason: 'Removed by the platform', moderatedBy: seller.profileId });
    expect((await db.select().from(schema.chatReports))[0]!.status).toBe('actioned');
    expect(await auditActions()).toEqual(['admin.chat.reject', 'chat.reject']);
    expect((await db.select().from(schema.auditLogs).then((r) => r.find((a) => a.action === 'admin.chat.reject')))!.actorWallet).toBe(admin.wallet);
  });

  it_('cancel a scheduled show through the engine; a second try is refused by the engine', async () => {
    expect((await post(R.cancel, '/api/admin/shows/cancel', { id: ids.show }, admin.cookie)).status).toBe(200);
    const [s] = await db.select().from(schema.shows);
    expect(s!.status).toBe('ended');
    expect(s!.cancelledAt).not.toBeNull();
    expect(await auditActions()).toContain('admin.show.cancel');
    expect((await post(R.cancel, '/api/admin/shows/cancel', { id: ids.show }, admin.cookie)).status).toBe(409);
    expect((await post(R.cancel, '/api/admin/shows/cancel', { id: '11111111-1111-4111-8111-111111111111' }, admin.cookie)).status).toBe(404);
  });

  it_('a write from another origin is refused even for an admin', async () => {
    const req = request('POST', '/api/admin/waitlist/delete', { cookie: admin.cookie, body: { id: ids.entry }, headers: { origin: 'https://evil.example' } });
    expect((await R.wlDelete(req)).status).toBe(403);
    expect(await db.select().from(schema.waitlist)).toHaveLength(1);
  });

  it_('the CSV export lists the entries, protects against formulas, and is audited', async () => {
    await db.insert(schema.waitlist).values({ email: '=cmd@example.com', locale: 'en' });
    const res = await R.csv(request('GET', '/api/admin/waitlist/export', { cookie: admin.cookie }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const text = await res.text();
    expect(text).toContain('"ada@example.com"');
    expect(text).toContain(`"'=cmd@example.com"`);
    expect(await auditActions()).toContain('admin.waitlist.export');
  });
});

describe('POST /api/waitlist', () => {
  const body = (o: Record<string, unknown> = {}) => ({ email: 'New.Person@Example.com', locale: 'de', website: '', ...o });
  const join = (b: unknown, ip?: string) => R.join(request('POST', '/api/waitlist', { body: b, ip }));

  it_('stores the address in lower case once and answers { ok: true }, also for the same address again in any case', async () => {
    await db.delete(schema.waitlist);
    const a = await join(body());
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ ok: true });
    expect(await (await join(body({ email: 'NEW.person@example.com', locale: 'en' }))).json()).toEqual({ ok: true });
    const rows = await db.select().from(schema.waitlist);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: 'new.person@example.com', locale: 'de', source: 'landing' });
  });

  it_('the honeypot: filled in answers 200 and stores nothing; a missing field is fine', async () => {
    await db.delete(schema.waitlist);
    expect(await (await join(body({ website: 'https://spam.example' }))).json()).toEqual({ ok: true });
    expect(await db.select().from(schema.waitlist)).toHaveLength(0);
    const { website: _w, ...noField } = body();
    void _w;
    expect((await join(noField)).status).toBe(200);
    expect(await db.select().from(schema.waitlist)).toHaveLength(1);
  });

  it_('validates: 400 with { error } for a bad address, a bad language and a broken body', async () => {
    await db.delete(schema.waitlist);
    for (const b of [body({ email: 'not-an-email' }), body({ email: '' }), body({ email: `${'a'.repeat(250)}@example.com` }), body({ locale: 'fr' }), { locale: 'de' }, 'not json', []]) {
      const res = await join(b);
      expect(res.status, JSON.stringify(b).slice(0, 40)).toBe(400);
      expect(typeof (await res.json()).error).toBe('string');
    }
    expect(await db.select().from(schema.waitlist)).toHaveLength(0);
  });

  it_('limits per address: the 9th request in an hour is 429 with Retry-After, another address is unaffected', async () => {
    await db.delete(schema.waitlist);
    const ip = '10.99.0.1';
    for (let i = 0; i < 8; i++) expect((await join(body({ email: `x${i}@example.com` }), ip)).status).toBe(200);
    const res = await join(body({ email: 'x9@example.com' }), ip);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(typeof (await res.json()).error).toBe('string');
    expect(await db.select().from(schema.waitlist)).toHaveLength(8);
    expect((await join(body({ email: 'other@example.com' }), '10.99.0.2')).status).toBe(200);
  });

  it_('fails closed: when the limiter cannot write, the request fails and nothing is stored', async () => {
    await db.delete(schema.waitlist);
    await t!.pool.query('alter table rate_limits rename to rate_limits_off');
    try {
      await expect(join(body())).rejects.toThrow();
    } finally {
      await t!.pool.query('alter table rate_limits_off rename to rate_limits');
    }
    expect(await db.select().from(schema.waitlist)).toHaveLength(0);
  });

  it_('never logs the address', async () => {
    const spies = (['log', 'info', 'warn', 'error'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    try {
      await join(body({ email: 'secret.person@example.com' }));
      await join(body({ email: 'secret.person@example.com', website: 'x' }));
      await join(body({ email: 'bad secret.person@example.com' }));
      for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain('secret.person');
    } finally { spies.forEach((s) => s.mockRestore()); }
  });
});
