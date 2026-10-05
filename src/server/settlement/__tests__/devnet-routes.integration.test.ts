/**
 * The devnet helpers called as route handlers over a REAL Postgres and the REAL Core and token programs (LiteSVM): the test-USDC
 * faucet, the demo-card mint and the metadata the cards point at. Limits, the SOL pause, refunds on failure and the
 * devnet-only rule are all exercised; nothing touches a network.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { count, eq } from 'drizzle-orm';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { DevnetMetadata, FaucetResponse, MintCardResponse } from '@/contracts';
import { startTestPg, type TestPg } from '@/db/__tests__/pg-harness';
import { MIN_SA_LAMPORTS } from '@/lib/chain/devnet';
import { CARD_TEMPLATES, REPLICA_LABEL } from '@/lib/chain/devnet-cards';
import { createWorld, type World } from '@/lib/chain/__tests__/svm-world';
import { createSvmPort } from '@/lib/chain/__tests__/svm-port';
import { ctx, request, responseChecks, signIn, svmDevnetIo } from './routekit';

let t: TestPg | undefined, skipReason: string | undefined;
let w: World, io: ReturnType<typeof svmDevnetIo>, lowSol = false, saReads = 0;
const saSol = 10_000_000_000n;
type Handler = (req: Request, c?: never) => Promise<Response>;
let R: { faucet: Handler; mint: Handler; metadata: (req: Request, c: { params: Promise<{ mint: string }> }) => Promise<Response> };
let db: typeof import('@/db').db, schema: typeof import('@/db').schema;
let dev: typeof import('../devnet');

const { ok, fails } = responseChecks(() => [w.sa, w.mintAuth, w.houseSeller].flatMap((k) => [bs58.encode(k.secretKey), JSON.stringify(Array.from(k.secretKey))]));

beforeAll(async () => {
  const r = await startTestPg({ poolMax: 10 });
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  t = r.pg;
  vi.stubEnv('DATABASE_URL', t.url);
  vi.stubEnv('SESSION_SECRET', 'integration-secret-integration-secret-01');
  vi.stubEnv('SOLANA_CLUSTER', 'devnet');
  ({ db, schema } = await import('@/db'));
  dev = await import('../devnet');
  w = createWorld();
  io = svmDevnetIo(w, { lamports: () => { saReads++; return lowSol ? MIN_SA_LAMPORTS - 1n : saSol; } });
  useDevnet('devnet');
  R = {
    faucet: (await import('@/app/api/devnet/faucet/route')).POST as Handler,
    mint: (await import('@/app/api/devnet/mint-card/route')).POST as Handler,
    metadata: (await import('@/app/api/devnet/metadata/[mint]/route')).GET,
  };
}, 120_000);
afterAll(async () => {
  dev?.setDevnetService(undefined);
  await (globalThis as { __pool?: { end(): Promise<void> } }).__pool?.end().catch(() => {});
  vi.unstubAllEnvs();
  await t?.pool.end().catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  await t?.stop();
});
const it_ = (name: string, fn: () => Promise<void> | void, timeout = 30_000) => it(name, async (c) => { if (!t) return c.skip(skipReason); await fn(); }, timeout);

function useDevnet(cluster: 'devnet' | 'mainnet-beta') {
  dev.setDevnetService(dev.createDevnetService({ db, io, cluster, sa: w.sa, faucetAuthority: w.mintAuth, usdcMint: w.usdc.toBase58(), collection: w.collection.toBase58() }));
}
const who = () => signIn(Keypair.generate());
const faucet = (cookie?: string, ip?: string, body: unknown = {}, headers?: Record<string, string>) => R.faucet(request('POST', '/api/devnet/faucet', { cookie, ip, body, headers }));
const mint = (cookie?: string, ip?: string, body: unknown = {}) => R.mint(request('POST', '/api/devnet/mint-card', { cookie, ip, body }));
const metadata = (m: string) => R.metadata(request('GET', `/api/devnet/metadata/${m}`), ctx({ mint: m }));
const rows = async (owner: string) => Number((await db.select({ n: count() }).from(schema.devnetAssets).where(eq(schema.devnetAssets.ownerWallet, owner)))[0]!.n);

describe('POST /api/devnet/faucet', () => {
  it_('mints 1,000 test USDC to the signed-in wallet, creating its token account at the platform\'s cost', async () => {
    const a = await who();
    const sa0 = w.sol(w.sa);
    const r = await ok(await faucet(a.cookie), FaucetResponse);
    expect(r).toMatchObject({ mint: w.usdc.toBase58(), amount: '1000000000' });
    expect(w.usdcOf(new (await import('@solana/web3.js')).PublicKey(a.wallet))).toBe(1_000_000_000n);
    expect(sa0 - w.sol(w.sa)).toBeGreaterThan(0n);
    const { rows: audit } = await t!.pool.query(`select target from audit_logs where action='devnet.faucet' and actor_wallet=$1`, [a.wallet]);
    expect(audit).toEqual([{ target: r.signature }]);
  });
  it_('one claim per wallet per 24 h: the second is rate_limited with Retry-After and mints nothing', async () => {
    const a = await who();
    await ok(await faucet(a.cookie), FaucetResponse);
    const sends = io.sends;
    const res = await faucet(a.cookie);
    const body = await fails(res, 'rate_limited');
    expect(res.headers.get('retry-after')).toBe(String(body.retryAfterS));
    expect(body.retryAfterS).toBeGreaterThan(0);
    expect(io.sends).toBe(sends);
  });
  it_('at most 3 requests per address per 24 h; a refused wallet keeps its own allowance for another address', async () => {
    const ip = '203.0.113.9';
    const [a, b, c, d] = [await who(), await who(), await who(), await who()];
    for (const x of [a, b, c]) await ok(await faucet(x.cookie, ip), FaucetResponse);
    await fails(await faucet(d.cookie, ip), 'rate_limited');
    await ok(await faucet(d.cookie), FaucetResponse); // not burnt by the refusal
  });
  it_('a failed mint gives the allowance back, for the wallet and for the address', async () => {
    const ip = '203.0.113.10', a = await who();
    io.fail = true;
    await fails(await faucet(a.cookie, ip), 'rpc_unavailable');
    await ok(await faucet(a.cookie, ip), FaucetResponse); // the same wallet may try again straight away
    for (let i = 0; i < 2; i++) await ok(await faucet((await who()).cookie, ip), FaucetResponse); // and the address still has its other two
  });
  it_('below 0.5 SOL on the settlement authority it pauses (faucet_paused) before any limit is spent and before anything is sent', async () => {
    const a = await who(), sends = io.sends;
    lowSol = true;
    try {
      const body = await fails(await faucet(a.cookie), 'faucet_paused');
      expect(body.reason).not.toMatch(/\d\.\d|SOL balance/i); // says paused, never how much SOL is left
    } finally { lowSol = false; }
    expect(io.sends).toBe(sends);
    await ok(await faucet(a.cookie), FaucetResponse);
  });
  it_('a refused caller costs no RPC call: the limits are checked before the SA balance read', async () => {
    const a = await who();
    await ok(await faucet(a.cookie), FaucetResponse);
    const reads = saReads;
    for (let i = 0; i < 5; i++) await fails(await faucet(a.cookie), 'rate_limited');
    expect(saReads).toBe(reads);
  });
  it_('a global daily cap bounds what anonymous wallets can make SA spend, and a refused caller keeps its own allowance', async () => {
    const a = await who(), ip = '203.0.113.77', day = 86_400_000, start = new Date(Math.floor(Date.now() / day) * day);
    const sends = io.sends;
    await db.insert(schema.rateLimits).values({ key: 'g:faucet', windowStart: start, count: dev.GLOBAL_FAUCET_PER_DAY }).onConflictDoUpdate({ target: [schema.rateLimits.key, schema.rateLimits.windowStart], set: { count: dev.GLOBAL_FAUCET_PER_DAY } });
    try {
      const body = await fails(await faucet(a.cookie, ip), 'rate_limited');
      expect(body.reason).toMatch(/daily limit/);
      expect(io.sends).toBe(sends);
      await db.insert(schema.rateLimits).values({ key: 'g:mint-card', windowStart: start, count: dev.GLOBAL_MINT_PER_DAY }).onConflictDoUpdate({ target: [schema.rateLimits.key, schema.rateLimits.windowStart], set: { count: dev.GLOBAL_MINT_PER_DAY } });
      await fails(await mint(a.cookie, ip), 'rate_limited');
      expect(await rows(a.wallet)).toBe(0); // no card, no row
    } finally {
      await db.delete(schema.rateLimits).where(eq(schema.rateLimits.key, 'g:faucet'));
      await db.delete(schema.rateLimits).where(eq(schema.rateLimits.key, 'g:mint-card'));
    }
    await ok(await faucet(a.cookie, ip), FaucetResponse); // the refusals gave the wallet and address allowance back
    await ok(await mint(a.cookie, ip), MintCardResponse);
  });
  it_('the operator kill switches (app_flags faucet / mint = false) stop both routes before any limit, RPC call or send', async () => {
    const a = await who(), { clearFlagMemo } = await import('@/app/api/auctions/_shared/flags');
    const set = async (key: string, v: boolean | null) => {
      if (v === null) await t!.pool.query(`delete from app_flags where key = $1`, [key]);
      else await t!.pool.query(`insert into app_flags (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = $2::jsonb`, [key, JSON.stringify(v)]);
      clearFlagMemo();
    };
    const sends = io.sends, reads = saReads;
    await set('faucet', false); await set('mint', false);
    try {
      await fails(await faucet(a.cookie), 'faucet_paused');
      await fails(await mint(a.cookie), 'mint_paused');
      expect(io.sends).toBe(sends);
      expect(saReads).toBe(reads);
      expect(await rows(a.wallet)).toBe(0);
    } finally { await set('faucet', null); await set('mint', null); }
    await ok(await faucet(a.cookie), FaucetResponse); // and nothing was spent: the wallet still has its claim
    await ok(await mint(a.cookie), MintCardResponse);
  });
  it_('devnet only: on any other cluster it is not_found', async () => {
    const a = await who();
    useDevnet('mainnet-beta');
    try { await fails(await faucet(a.cookie), 'not_found'); } finally { useDevnet('devnet'); }
  });
  it_('needs a session, a JSON body without extras, and a same-origin request', async () => {
    const a = await who();
    await fails(await faucet(undefined), 'unauthenticated');
    await fails(await faucet(a.cookie, undefined, { amount: 1_000_000_000_000 }), 'validation');
    await fails(await faucet(a.cookie, undefined, {}, { origin: 'https://evil.example' }), 'forbidden');
    await fails(await faucet(a.cookie, undefined, '{not json'), 'validation');
  });
});

describe('POST /api/devnet/mint-card', () => {
  it_('mints one Core replica to the caller inside the vault collection, with its facts stored for the metadata route', async () => {
    const a = await who();
    const r = await ok(await mint(a.cookie), MintCardResponse);
    expect(r.name).toMatch(/\(devnet replica\)$/);
    const info = await createSvmPort(w).readAsset(r.mint);
    expect(info).toMatchObject({ standard: 'core', owner: a.wallet, collection: w.collection.toBase58(), frozen: false });
    const [row] = await db.select().from(schema.devnetAssets).where(eq(schema.devnetAssets.mint, r.mint));
    expect(row).toMatchObject({ ownerWallet: a.wallet, name: r.name });
    expect(CARD_TEMPLATES.map((c) => c.imageUrl)).toContain(row!.imageUrl);
    expect(row!.attributes).toEqual(expect.arrayContaining([{ trait_type: 'Label', value: REPLICA_LABEL }]));
  });
  it_('a template can be chosen; an unknown one is a validation error that lists the choices', async () => {
    const a = await who();
    const r = await ok(await mint(a.cookie, undefined, { template: 'volto-cgc10' }), MintCardResponse);
    expect(r.name).toContain('Volto');
    const body = await fails(await mint(a.cookie, undefined, { template: 'nope' }), 'validation');
    expect(body.reason).toContain('volto-cgc10');
  });
  it_('3 per wallet per day, then rate_limited', async () => {
    const a = await who();
    for (let i = 0; i < 3; i++) await ok(await mint(a.cookie), MintCardResponse);
    const res = await mint(a.cookie);
    const body = await fails(res, 'rate_limited');
    expect(res.headers.get('retry-after')).toBe(String(body.retryAfterS));
    expect(await rows(a.wallet)).toBe(3);
  });
  it_('at most 10 per address per day (many wallets from one address cannot drain the platform\'s SOL)', async () => {
    const ip = '203.0.113.20';
    const wallets = [await who(), await who(), await who(), await who()];
    for (const x of wallets.slice(0, 3)) for (let i = 0; i < 3; i++) await ok(await mint(x.cookie, ip), MintCardResponse);
    await ok(await mint(wallets[3]!.cookie, ip), MintCardResponse); // the 10th
    await fails(await mint(wallets[3]!.cookie, ip), 'rate_limited');
    await ok(await mint(wallets[3]!.cookie), MintCardResponse); // from another address the wallet still has its allowance
  });
  it_('a failed mint leaves no row behind and gives the allowance back', async () => {
    const a = await who();
    io.fail = true;
    await fails(await mint(a.cookie), 'rpc_unavailable');
    expect(await rows(a.wallet)).toBe(0);
    for (let i = 0; i < 3; i++) await ok(await mint(a.cookie), MintCardResponse);
    expect(await rows(a.wallet)).toBe(3);
  });
  it_('below 0.5 SOL it pauses (mint_paused) and sends nothing; devnet only; needs a session', async () => {
    const a = await who(), sends = io.sends;
    lowSol = true;
    try { await fails(await mint(a.cookie), 'mint_paused'); } finally { lowSol = false; }
    expect(io.sends).toBe(sends);
    expect(await rows(a.wallet)).toBe(0);
    useDevnet('mainnet-beta');
    try { await fails(await mint(a.cookie), 'not_found'); } finally { useDevnet('devnet'); }
    await fails(await mint(undefined), 'unauthenticated');
    await fails(await mint(a.cookie, undefined, { template: 'x'.repeat(41) }), 'validation');
  });
});

describe('mintCopy (the devnet demo pack: a copy of the drawn replica into the buyer\'s wallet)', () => {
  /** A house replica as the restock writes it: the plain key/value attributes. */
  async function source(attributes: unknown = { replica: 'true', replica_of: 'RealCardMint', grade: 'MINT 9', grading_company: 'PSA', set: 'Base' }) {
    const mint = Keypair.generate().publicKey.toBase58();
    await db.insert(schema.devnetAssets).values({ mint, ownerWallet: w.houseSeller.publicKey.toBase58(), name: 'Source card (devnet replica)', imageUrl: 'https://img.example/source.png', attributes });
    return mint;
  }
  const copy = (wallet: string, src: string) => dev.getDevnetService().mintCopy({ wallet, origin: 'https://hp.test', source: src });
  const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as { code?: string }).code; } return 'no error'; };

  it_('mints a NEW Core replica into the wallet with the name, image and traits of the source, in the vault collection, and does not use the /sell daily limits', async () => {
    const src = await source(), wallet = Keypair.generate().publicKey.toBase58();
    const first = await copy(wallet, src);
    for (let i = 0; i < 3; i++) await copy(wallet, src); // four copies for one wallet: the demo pack has its own cap, the 3 a day of the /sell button do not apply
    expect(await rows(wallet)).toBe(4);
    expect(first.mint).not.toBe(src);
    expect(first.name).toBe('Source card (devnet replica)');
    expect(await createSvmPort(w).readAsset(first.mint)).toMatchObject({ standard: 'core', owner: wallet, collection: w.collection.toBase58(), frozen: false });
    const [row] = await db.select().from(schema.devnetAssets).where(eq(schema.devnetAssets.mint, first.mint));
    expect(row).toMatchObject({ ownerWallet: wallet, name: 'Source card (devnet replica)', imageUrl: 'https://img.example/source.png' });
    expect(row!.attributes).toHaveLength(5); // stored as the same trait list the /sell mint stores
    expect(row!.attributes).toEqual(expect.arrayContaining([{ trait_type: 'Replica of', value: 'RealCardMint' }, { trait_type: 'Grade', value: 'MINT 9' }, { trait_type: 'Grading Company', value: 'PSA' }]));
    const j = DevnetMetadata.parse(await (await metadata(first.mint)).json()); // and the wallet-facing metadata is the source's
    expect(j).toMatchObject({ name: 'Source card (devnet replica)', symbol: 'HPCARD', image: 'https://img.example/source.png', description: REPLICA_LABEL });
    expect(j.attributes).toEqual(expect.arrayContaining([{ trait_type: 'Replica of', value: 'RealCardMint' }]));
    const [orig] = await db.select().from(schema.devnetAssets).where(eq(schema.devnetAssets.mint, src));
    expect(orig!.ownerWallet).toBe(w.houseSeller.publicKey.toBase58()); // the source stays the house's: the demo pool never runs down
  });
  it_('keeps the SOL guard and the devnet rule; an unknown source and a failed send leave no row and no card', async () => {
    const src = await source(), wallet = Keypair.generate().publicKey.toBase58(), sends = io.sends;
    lowSol = true;
    try { expect(await code(copy(wallet, src))).toBe('mint_paused'); } finally { lowSol = false; }
    expect(await code(copy(wallet, Keypair.generate().publicKey.toBase58()))).toBe('not_found');
    io.fail = true;
    expect(await code(copy(wallet, src))).toBe('rpc_unavailable');
    expect(io.sends).toBe(sends);
    expect(await rows(wallet)).toBe(0);
    useDevnet('mainnet-beta');
    try { expect(await code(copy(wallet, src))).toBe('not_found'); } finally { useDevnet('devnet'); }
    await copy(wallet, src); // and it works again
    expect(await rows(wallet)).toBe(1);
  });
});

describe('GET /api/devnet/metadata/:mint', () => {
  it_('public and cacheable: the card\'s name, the real vault photo and its facts, labelled as a replica', async () => {
    const a = await who();
    const m = await ok(await mint(a.cookie, undefined, { template: 'gengar-psa8' }), MintCardResponse);
    const res = await metadata(m.mint);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('vercel-cdn-cache-control')).toBe('max-age=3600');
    const j = DevnetMetadata.parse(await res.json());
    expect(j).toMatchObject({ name: m.name, symbol: 'HPCARD', description: REPLICA_LABEL });
    expect(j.image).toMatch(/^https:\/\/d1xpxki1g4htqu\.cloudfront\.net\//);
    expect(j.attributes).toEqual(expect.arrayContaining([{ trait_type: 'Grade', value: 'NM-MT 8' }, { trait_type: 'Grading Company', value: 'PSA' }, { trait_type: 'Replica of', value: '8T4sgEwm2e2R5XHyAz9PnViSTr9yxnXozeG1Dd336trs' }]));
  });
  it_('the collection address answers too; rows written as a plain key/value object by the first inventory run are served as trait lists', async () => {
    expect((await metadata('collection')).status).toBe(200);
    const mintAddr = Keypair.generate().publicKey.toBase58();
    await db.insert(schema.devnetAssets).values({ mint: mintAddr, ownerWallet: 'someone', name: 'Old row', imageUrl: null, attributes: { grade: 'MINT 9', grading_company: 'PSA', replica: 'true' } });
    const j = DevnetMetadata.parse(await (await metadata(mintAddr)).json());
    expect(j.attributes).toHaveLength(3); // jsonb does not keep key order
    expect(j.attributes).toEqual(expect.arrayContaining([{ trait_type: 'Grade', value: 'MINT 9' }, { trait_type: 'Grading Company', value: 'PSA' }, { trait_type: 'Replica', value: 'true' }]));
    expect(j.image).toMatch(/\/icons\/icon-512\.png$/);
  });
  it_('an unknown card or a malformed address is not_found and is never cached', async () => {
    for (const m of [Keypair.generate().publicKey.toBase58(), 'not base58!', '../etc']) {
      const res = await metadata(m);
      await fails(res, 'not_found');
      expect(res.headers.get('vercel-cdn-cache-control')).toBeNull();
    }
  });
});
