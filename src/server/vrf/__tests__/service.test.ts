/**
 * The draw's state machine against a real Postgres (embedded) and an in-memory chain: commit, beacon, reveal, renumbering, the lease,
 * crash safety (a stored transaction is sent again byte for byte, never rebuilt while it can still land), the deadline, and the secrets.
 * After each full run the BROWSER verifier (lib/vrf) checks all nine rules against the same fake chain.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { VrfRequestView as ContractView } from '@/contracts/vrf';
import { ChainError } from '@/lib/chain/errors';
import { verifyRequest } from '@/lib/vrf';
import { generateVrfKey, type VrfKey } from '@/lib/vrf/key';
import { startEnv, type Env } from '@/server/auction/__tests__/harness';
import { FakeChain } from './fake-chain';
import type { VrfDeps } from '../service';

let env: Env | undefined; let skipReason: string | undefined;
let S: typeof import('../service');
let R: typeof import('../raffle');
let key: VrfKey; let secretEnv: string;
const sa = Keypair.generate();

beforeAll(async () => {
  const r = await startEnv();
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  env = r.env;
  S = await import('../service');
  R = await import('../raffle');
  const g = generateVrfKey(); key = g.key; secretEnv = g.envValue;
}, 180_000);
afterAll(async () => { await env?.stop(); });
beforeEach(async () => {
  if (!env) return;
  await env.pool.query(`delete from vrf_requests; delete from rate_limits; delete from bids; delete from paddles; delete from show_events; delete from lots; delete from shows`);
});
afterEach(() => { vi.restoreAllMocks(); });

const t = (name: string, fn: (e: Env) => Promise<void>, timeout = 60_000) => it(name, async (ctx) => { if (!env) return ctx.skip(skipReason); await fn(env); }, timeout);
const deps = (chain: FakeChain, over: Partial<VrfDeps> = {}): VrfDeps => ({ chain, key, sa, cluster: chain.cluster, now: () => new Date(), sleep: async () => {}, env: {}, budgetMs: 60_000, ...over });

async function lotShow(e: Env, states: ('catalogued' | 'open')[] = ['catalogued', 'catalogued', 'catalogued', 'catalogued', 'catalogued', 'catalogued']) {
  const seller = await e.profile();
  const s = await e.show({ sellerId: seller.id, status: 'scheduled', scheduledAt: new Date(Date.now() + 60_000), lots: states.map((state) => ({ state })) });
  await e.pool.query(`update shows set order_mode = 'vrf' where id = $1`, [s.id]);
  return { ...s, seller };
}
const numbers = async (e: Env, showId: string) => (await e.pool.query(`select id, lot_number from lots where show_id = $1 order by lot_number`, [showId])).rows.map((r) => r.id as string);
const row = async (e: Env, id: string) => (await e.pool.query(`select * from vrf_requests where id = $1`, [id])).rows[0];

describe('a drawn lot order, end to end', () => {
  t('commit, beacon, reveal: the lots are renumbered and the browser verifier passes all nine rules', async (e) => {
    const s = await lotShow(e);
    const chain = new FakeChain();
    const made = await S.requestLotOrder(s.id, { ...deps(chain), revealWindowS: 120 });
    expect(made).toMatchObject({ created: true });
    const view = await S.advance(made!.id, deps(chain));
    expect(view?.status).toBe('revealed');
    expect(chain.sent).toHaveLength(2); // one commit, one reveal
    const parsed = ContractView.parse(view); // the answer is a valid contract view
    expect(parsed.result).toMatchObject({ applied: true });
    const order = (view!.result as { order: string[] }).order;
    expect(await numbers(e, s.id)).toEqual(order); // the lot at position i has number i + 1
    const checks = await verifyRequest(view!, { rpc: chain.rpc() });
    expect(checks.map((c) => `${c.id}:${c.status}`)).toEqual(['params_hash:pass', 'alpha:pass', 'proof:pass', 'output:pass', 'result:pass', 'commit_memo:pass', 'beacon:pass', 'reveal_memo:pass', 'single_commit:pass']);
  });

  t('the view hides beacon, proof and output until the request is revealed, and never carries transaction bytes', async (e) => {
    const s = await lotShow(e);
    const chain = new FakeChain();
    chain.slotsPerPoll = 1; // the beacon is far away: the draw stays committed
    const made = (await S.requestLotOrder(s.id, deps(chain)))!;
    const view = await S.advance(made.id, deps(chain, { budgetMs: 3_000 }));
    expect(view).toMatchObject({ status: 'committed', alphaText: null, beacon: null, proofHex: null, outputHex: null, revealTx: null, result: null });
    expect(view!.commitTx).toBeTruthy();
    expect(JSON.stringify(view)).not.toMatch(/tx_b64|TxB64|lease/i);
    expect(chain.sent).toHaveLength(1);
  });

  t('advance is idempotent: the same request advanced again changes nothing and sends nothing', async (e) => {
    const s = await lotShow(e);
    const chain = new FakeChain();
    const made = (await S.requestLotOrder(s.id, deps(chain)))!;
    const a = await S.advance(made.id, deps(chain));
    const b = await S.advance(made.id, deps(chain));
    expect(b).toEqual(a);
    expect(chain.sent).toHaveLength(2);
  });

  t('requesting the same order twice returns the same request (one draw per show, ever)', async (e) => {
    const s = await lotShow(e);
    const chain = new FakeChain();
    const a = (await S.requestLotOrder(s.id, deps(chain)))!;
    const b = (await S.requestLotOrder(s.id, deps(chain)))!;
    expect(b).toEqual({ id: a.id, created: false });
    expect((await e.pool.query(`select count(*)::int c from vrf_requests`)).rows[0].c).toBe(1);
  });

  t('two advances at once make exactly one commit and one reveal (the lease)', async (e) => {
    const s = await lotShow(e);
    const chain = new FakeChain();
    const made = (await S.requestLotOrder(s.id, deps(chain)))!;
    const [a, b] = await Promise.all([S.advance(made.id, deps(chain)), S.advance(made.id, deps(chain))]);
    const again = await S.advance(made.id, deps(chain));
    expect([a, b].some((v) => v?.status === 'revealed') || again?.status === 'revealed').toBe(true);
    expect(chain.sent).toHaveLength(2);
    expect(new Set(chain.sent).size).toBe(2);
  });

  t('a crash after storing but before sending sends the SAME bytes next time', async (e) => {
    const s = await lotShow(e);
    const chain = new FakeChain();
    const made = (await S.requestLotOrder(s.id, deps(chain)))!;
    chain.failSend = new ChainError('rpc_unavailable', 'down');
    await S.advance(made.id, deps(chain, { budgetMs: 0 }));
    const stored = await row(e, made.id);
    expect(stored.commit_tx_b64).toBeTruthy(); // stored first
    expect(chain.landed.size).toBe(0);
    chain.failSend = null;
    const view = await S.advance(made.id, deps(chain));
    expect(view?.status).toBe('revealed');
    expect((await row(e, made.id)).commit_signature).toBe(stored.commit_signature); // the commit was never rebuilt
    expect(chain.sent.filter((x) => x === stored.commit_signature).length).toBeGreaterThanOrEqual(1);
    expect(chain.landed.has(stored.commit_signature)).toBe(true);
  });

  t('a stored transaction is rebuilt only when its blockhash can no longer land and the chain does not know it', async (e) => {
    const s = await lotShow(e);
    const chain = new FakeChain();
    chain.land = false; // the node swallows it
    const made = (await S.requestLotOrder(s.id, deps(chain)))!;
    await S.advance(made.id, deps(chain, { budgetMs: 0 }));
    const first = await row(e, made.id);
    await S.advance(made.id, deps(chain, { budgetMs: 0 }));
    expect((await row(e, made.id)).commit_signature).toBe(first.commit_signature); // still alive: kept
    const bh = (await import('../chain')).blockhashOfTx(first.commit_tx_b64);
    chain.expired.add(bh);
    await S.advance(made.id, deps(chain, { budgetMs: 0 }));
    const second = await row(e, made.id);
    expect(second.commit_signature).not.toBe(first.commit_signature); // dead: a fresh transaction
    expect(second.attempts).toBe(2);
  });

  t('a transaction that landed but is not final yet is waited for, not sent again', async (e) => {
    const s = await lotShow(e);
    const chain = new FakeChain();
    chain.landLevel = 'confirmed';
    const made = (await S.requestLotOrder(s.id, deps(chain)))!;
    const view = await S.advance(made.id, deps(chain, { budgetMs: 4_000 }));
    expect(view?.status).toBe('pending'); // the commit is on the chain but not final
    expect(chain.sent).toHaveLength(1); // and it was sent once, however often the draw looked at it
    chain.finalizeAll(); chain.landLevel = 'finalized';
    expect((await S.advance(made.id, deps(chain)))?.status).toBe('revealed');
    expect(chain.sent.filter((x, i, a) => a.indexOf(x) === i)).toHaveLength(2);
  });

  t('the reveal is deterministic: a swallowed and rebuilt reveal carries the same proof', async (e) => {
    const s = await lotShow(e);
    const chain = new FakeChain();
    const made = (await S.requestLotOrder(s.id, deps(chain)))!;
    chain.slotsPerPoll = 1; // the commit becomes final, the beacon is still far away
    await S.advance(made.id, deps(chain, { budgetMs: 3_000 }));
    expect((await row(e, made.id)).status).toBe('committed');
    chain.slotsPerPoll = 40; chain.land = false; // beacon reached, but the node swallows the reveal
    await S.advance(made.id, deps(chain, { budgetMs: 0 }));
    const r1 = await row(e, made.id);
    expect(r1.status).toBe('committed');
    expect(r1.reveal_tx_b64).toBeTruthy();
    chain.expired.add((await import('../chain')).blockhashOfTx(r1.reveal_tx_b64));
    chain.land = true;
    const view = await S.advance(made.id, deps(chain));
    expect(view?.status).toBe('revealed');
    const r2 = await row(e, made.id);
    expect(r2.reveal_signature).not.toBe(r1.reveal_signature); // a fresh transaction (new blockhash) ...
    expect(r2.proof_hex).toBe(r1.proof_hex); // ... for the same proof
    expect(r2.beacon_slot).toBe(r1.beacon_slot);
  });
});

describe('the lot renumbering', () => {
  t('is skipped (applied: false) when a lot is already open: the order is only recorded', async (e) => {
    const s = await lotShow(e, ['open', 'catalogued', 'catalogued']);
    const before = await numbers(e, s.id);
    const chain = new FakeChain();
    const made = (await S.requestLotOrder(s.id, deps(chain)))!;
    const view = await S.advance(made.id, deps(chain));
    expect(view?.status).toBe('revealed');
    expect(view!.result).toMatchObject({ applied: false });
    expect(await numbers(e, s.id)).toEqual(before);
    const checks = await verifyRequest(view!, { rpc: chain.rpc() });
    expect(checks.filter((c) => c.kind === 'crypto').every((c) => c.status === 'pass')).toBe(true); // `applied` is not part of the proof
  });

  t('is skipped when the show no longer holds the committed lots (one was withdrawn)', async (e) => {
    const s = await lotShow(e);
    const chain = new FakeChain();
    const made = (await S.requestLotOrder(s.id, deps(chain)))!;
    await e.pool.query(`update lots set state = 'withdrawn' where id = $1`, [s.lots[2]]);
    const view = await S.advance(made.id, deps(chain));
    expect(view!.result).toMatchObject({ applied: false });
  });

  t('one lot: nothing to shuffle, the draw still proves', async (e) => {
    const s = await lotShow(e, ['catalogued']);
    const chain = new FakeChain();
    const made = (await S.requestLotOrder(s.id, deps(chain)))!;
    const view = await S.advance(made.id, deps(chain));
    expect(view!.result).toEqual({ order: s.lots, applied: true });
  });

  t('a show without lots gets no request', async (e) => {
    const seller = await e.profile();
    const s = await e.show({ sellerId: seller.id, status: 'scheduled', lots: [] });
    expect(await S.requestLotOrder(s.id, deps(new FakeChain()))).toBeNull();
  });
});

describe('the deadline', () => {
  t('past reveal_by an open draw defaults to the catalogue order, and a later reveal is not accepted', async (e) => {
    const s = await lotShow(e);
    const chain = new FakeChain();
    chain.slotsPerPoll = 1; // never gets to the reveal in time
    const made = (await S.requestLotOrder(s.id, { ...deps(chain), revealWindowS: 120 }))!;
    await S.advance(made.id, deps(chain, { budgetMs: 1_500 }));
    const late = deps(chain, { now: () => new Date(Date.now() + 121_000) });
    const view = await S.advance(made.id, late);
    expect(view).toMatchObject({ status: 'defaulted', result: { order: s.lots, applied: false } });
    chain.slotsPerPoll = 40;
    const after = await S.advance(made.id, deps(chain)); // the chain is fast now: too late, nothing is accepted
    expect(after?.status).toBe('defaulted');
    expect(await numbers(e, s.id)).toEqual(s.lots);
    const checks = await verifyRequest(after!, { rpc: chain.rpc() });
    expect(checks.some((c) => c.status === 'fail')).toBe(false); // a defaulted draw is never "proven" and never a failure
  });

  t('a reveal that lands after the deadline defaults instead of applying', async (e) => {
    const s = await lotShow(e);
    const chain = new FakeChain();
    const made = (await S.requestLotOrder(s.id, { ...deps(chain), revealWindowS: 120 }))!;
    chain.blockTimeOffset = 200; // the chain's clock says the reveal came 200 s later than allowed
    const view = await S.advance(made.id, deps(chain));
    expect(view?.status).toBe('defaulted');
    expect(await numbers(e, s.id)).toEqual(s.lots);
  });

  t('the sweep defaults overdue requests and advances the others', async (e) => {
    const a = await lotShow(e);
    const b = await lotShow(e);
    const chain = new FakeChain();
    const ra = (await S.requestLotOrder(a.id, deps(chain)))!;
    const rb = (await S.requestLotOrder(b.id, deps(chain)))!;
    await e.pool.query(`update vrf_requests set reveal_by = now() - interval '1 minute' where id = $1`, [ra.id]);
    expect(await S.sweepRequests(deps(chain))).toBe(2);
    expect((await row(e, ra.id)).status).toBe('defaulted');
    expect((await row(e, rb.id)).status).toBe('revealed');
  });
});

describe('the settlement authority pays: limits', () => {
  t('below the balance floor no transaction is sent, and the draw stays open until its deadline', async (e) => {
    const s = await lotShow(e);
    const chain = new FakeChain();
    chain.lamportsOf = 1_000n;
    const made = (await S.requestLotOrder(s.id, deps(chain)))!;
    const view = await S.advance(made.id, deps(chain));
    expect(view?.status).toBe('pending');
    expect(chain.sent).toHaveLength(0);
  });

  t('the daily cap stops new transactions (SA_VRF_MEMOS_PER_DAY)', async (e) => {
    const s = await lotShow(e);
    const chain = new FakeChain();
    const made = (await S.requestLotOrder(s.id, deps(chain)))!;
    const view = await S.advance(made.id, deps(chain, { env: { SA_VRF_MEMOS_PER_DAY: '1' } }));
    expect(chain.sent).toHaveLength(1); // the commit; the reveal is over the cap
    expect(view?.status).toBe('committed');
  });

  t('mainnet-beta: the same flow, with the mainnet cluster in the proof and a lower balance floor', async (e) => {
    const s = await lotShow(e);
    const chain = new FakeChain('mainnet-beta');
    chain.lamportsOf = 80_000_000n; // above the mainnet floor, below the devnet one
    const d = deps(chain, { env: { SOLANA_CLUSTER: 'mainnet-beta' } });
    const made = (await S.requestLotOrder(s.id, d))!;
    const view = await S.advance(made.id, d);
    expect(view?.status).toBe('revealed');
    expect(view!.cluster).toBe('mainnet-beta');
    expect(view!.alphaText).toContain('cluster: mainnet-beta');
    expect((await verifyRequest(view!, { rpc: chain.rpc() })).every((c) => c.status === 'pass')).toBe(true);
  });

  t('a deployment never drives a request of the other cluster', async (e) => {
    const s = await lotShow(e);
    const made = (await S.requestLotOrder(s.id, deps(new FakeChain())))!;
    const chainMain = new FakeChain('mainnet-beta');
    const view = await S.advance(made.id, deps(chainMain, { env: { SOLANA_CLUSTER: 'mainnet-beta' } }));
    expect(view?.status).toBe('pending');
    expect(chainMain.sent).toHaveLength(0);
  });
});

describe('secrets', () => {
  t('the VRF secret appears in no log line, error or view', async (e) => {
    const logs: string[] = [];
    for (const m of ['log', 'warn', 'error', 'info', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    const s = await lotShow(e);
    const chain = new FakeChain();
    chain.failSend = new ChainError('rpc_unavailable', 'down');
    const made = (await S.requestLotOrder(s.id, deps(chain)))!;
    await S.advance(made.id, deps(chain, { budgetMs: 0 }));
    chain.failSend = null;
    const view = await S.advance(made.id, deps(chain));
    const secretBytes: number[] = JSON.parse(secretEnv);
    const hay = JSON.stringify(view) + logs.join('\n') + String(key) + JSON.stringify(key);
    expect(hay).not.toContain(secretEnv);
    expect(hay).not.toContain(String(secretBytes.slice(0, 8)));
    expect(hay).not.toContain(Buffer.from(secretBytes.slice(0, 32)).toString('hex'));
  });
});

describe('the thank-you draw', () => {
  const end = (e: Env, showId: string) => e.pool.query(`update shows set status = 'ended', ended_at = now(), order_mode = 'catalogue' where id = $1`, [showId]);
  async function bidder(e: Env, showId: string, lotId: string, o: { bot?: boolean; via?: string } = {}) {
    const p = await e.profile({ bot: o.bot });
    const pad = await e.paddle(showId, p.id);
    await e.pool.query(`insert into bids (lot_id, bidder_id, amount, signature, message, nonce, via, paddle_id) values ($1,$2,5,'s','m',$3,$4,$5)`, [lotId, p.id, `n-${pad.number}`, o.via ?? 'session', pad.id]);
    return pad.number;
  }

  t('draws a winner among the human bidders: no bots, no house bids, no seller; needs two entrants', async (e) => {
    const s = await lotShow(e);
    const chain = new FakeChain();
    await bidder(e, s.id, s.lots[0]!, { bot: true });
    await bidder(e, s.id, s.lots[0]!, { via: 'house' });
    const one = await bidder(e, s.id, s.lots[0]!);
    await end(e, s.id);
    expect(await R.requestRaffle(s.id, deps(chain))).toBeNull(); // one human: nothing to draw
    await e.pool.query(`update shows set status = 'live' where id = $1`, [s.id]);
    const two = await bidder(e, s.id, s.lots[1]!);
    const three = await bidder(e, s.id, s.lots[1]!);
    await end(e, s.id);
    expect(await R.raffleEntrants(s.id)).toEqual([one, two, three].sort((a, b) => a - b));
    const made = (await R.requestRaffle(s.id, deps(chain)))!;
    expect(await R.requestRaffle(s.id, deps(chain))).toEqual({ id: made.id, created: false });
    const view = await S.advance(made.id, deps(chain));
    expect(view?.status).toBe('revealed');
    const res = view!.result as { winnerPaddle: number; entrants: number[] };
    expect(res.entrants).toEqual([one, two, three].sort((a, b) => a - b));
    expect(res.entrants).toContain(res.winnerPaddle);
    expect((await verifyRequest(view!, { rpc: chain.rpc() })).every((c) => c.status === 'pass')).toBe(true);
    expect(await numbers(e, s.id)).toEqual(s.lots); // a raffle never touches the lot order
  });

  t('requestRecentRaffles: only house shows that ended within the hour, and only once', async (e) => {
    const D = await import('../driver');
    const mk = async (o: { house: boolean; endedAgo: string }) => {
      const s = await lotShow(e);
      await bidder(e, s.id, s.lots[0]!); await bidder(e, s.id, s.lots[1]!);
      await e.pool.query(`update shows set status = 'ended', ended_at = now() - $2::interval, is_house = $3, order_mode = 'catalogue' where id = $1`, [s.id, o.endedAgo, o.house]);
      return s.id;
    };
    const fresh = await mk({ house: true, endedAgo: '5 minutes' });
    await mk({ house: false, endedAgo: '5 minutes' });
    await mk({ house: true, endedAgo: '3 hours' });
    const d = deps(new FakeChain());
    const made = await D.requestRecentRaffles(d);
    expect(made).toHaveLength(1);
    expect((await e.pool.query(`select subject_id from vrf_requests where id = $1`, [made[0]])).rows[0].subject_id).toBe(fresh);
    expect(await D.requestRecentRaffles(d)).toEqual([]); // once
  });

  t('a show that has not ended has no draw', async (e) => {
    const s = await lotShow(e);
    await e.pool.query(`update shows set status = 'live' where id = $1`, [s.id]);
    await bidder(e, s.id, s.lots[0]!); await bidder(e, s.id, s.lots[0]!);
    expect(await R.requestRaffle(s.id, deps(new FakeChain()))).toBeNull();
  });

  t('the draws of a show are listed for the chip and the verify page', async (e) => {
    const s = await lotShow(e);
    const made = (await S.requestLotOrder(s.id, deps(new FakeChain())))!;
    expect(await S.showDraws(s.id)).toEqual({ lotOrder: { requestId: made.id, status: 'pending' }, raffle: null });
  });
});

describe('the key page counters', () => {
  t('count commits, reveals and defaults of this key on this cluster', async (e) => {
    const chain = new FakeChain();
    const a = await lotShow(e); const b = await lotShow(e);
    const ra = (await S.requestLotOrder(a.id, deps(chain)))!; const rb = (await S.requestLotOrder(b.id, deps(chain)))!;
    await S.advance(ra.id, deps(chain));
    await e.pool.query(`update vrf_requests set reveal_by = now() - interval '1 minute' where id = $1`, [rb.id]);
    await S.sweepRequests(deps(chain));
    expect(await S.keyStats({ key, env: {} })).toEqual({ commits: 1, reveals: 1, defaults: 1 });
  });
});

describe('the public view of a pack draw that is not paid yet', () => {
  t('shows no proof, output, beacon, params or result (the rule: the result only after the payment)', async () => {
    const full = ContractView.parse({
      id: '0b9e9c1e-0000-4000-8000-000000000001', purpose: 'pack_draw', subject: { type: 'pack_draw', id: 'draw' }, status: 'revealed', cluster: 'devnet',
      publicKey: Keypair.generate().publicKey.toBase58(), params: { pack: 'x' }, paramsHash: 'a'.repeat(64), alphaText: 'alpha',
      beacon: { slot: 1, blockhash: Keypair.generate().publicKey.toBase58() }, commitTx: null, commitSlot: null, revealBy: new Date().toISOString(),
      proofHex: 'b'.repeat(160), outputHex: 'c'.repeat(128), revealTx: null, result: { tier: 'legend', position: 3, asset: 'ASSET' },
    });
    const hidden = ContractView.parse(S.hideUnpaidDraw(full as never));
    expect(hidden).toMatchObject({ alphaText: null, beacon: null, proofHex: null, outputHex: null, revealTx: null, result: null, params: {} });
    expect(JSON.stringify(hidden)).not.toMatch(/legend|ASSET|"alpha"|bbbb|cccc/);
  });
});
