/**
 * The seller journey end to end with a fetch stub and the pure wizard: read the wallet, pick three cards, set terms,
 * re-check readiness, publish in one call. The React shell only wires these calls to events.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CreateShowRequest, ShowDetail, type SellAsset } from '@/contracts/api';
import { createShow, getSellAssets } from '../api';
import { readRecent, rememberShow } from '../recent';
import { allReady, applyAssets, buildCreateRequest, canPublish, initialState, markChecking, setTerm, togglePick, type WizardState } from '../wizardState';
import { fixture, stubFetch, unstub } from './fetchStub';

process.env.TZ = 'Europe/Berlin';
afterEach(unstub);

const NOW = new Date('2026-10-05T10:00:00Z');
const CORE = fixture<{ assets: SellAsset[] }>('sell-assets').assets[0];
const cards: SellAsset[] = ['A', 'B', 'C'].map((c, i) => ({ ...CORE, mint: c.repeat(43) + String(i + 1), name: `Card ${c}` }));
const walletAnswer = (over: (a: SellAsset) => Partial<SellAsset> = () => ({})) => ({ body: { assets: cards.map((a) => ({ ...a, ...over(a) })) } });

async function pickAll() {
  const r = await getSellAssets();
  if (!r.ok) throw new Error('assets');
  let s = initialState(NOW);
  for (const a of r.data.assets) s = togglePick(s, a);
  s = setTerm(s, cards[0].mint, 'reserve', '120');
  s = setTerm(s, cards[1].mint, 'opening', '25,5');
  return { ...s, title: 'Saturday night slabs', when: 'schedule', start: '2026-10-06T20:00' } satisfies Partial<WizardState> as WizardState;
}

describe('seller flow', () => {
  it('publishes three lots in ONE POST /api/shows after a fresh readiness read', async () => {
    const calls = stubFetch({
      'GET /api/sell/assets': walletAnswer(),
      'POST /api/shows': { status: 201, body: fixture('show-detail') },
    });
    let s = await pickAll();
    expect(canPublish(s, NOW)).toBe(false); // nothing is ready before the check

    s = markChecking(s);
    const fresh = await getSellAssets();
    s = applyAssets(s, fresh.ok ? fresh.data.assets : []);
    expect(allReady(s)).toBe(true);
    expect(canPublish(s, NOW)).toBe(true);

    const body = buildCreateRequest(s, NOW)!;
    const r = await createShow(body);
    expect(r.ok && ShowDetail.safeParse(r.data).success).toBe(true);

    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(CreateShowRequest.safeParse(posts[0].body).success).toBe(true);
    expect(posts[0].body).toMatchObject({
      title: 'Saturday night slabs', mode: 'auto', scheduledAt: '2026-10-06T18:00:00.000Z',
      lots: [
        { mint: cards[0].mint, reserve: '120000000', openingPrice: '10000000', increment: '1000000' },
        { mint: cards[1].mint, openingPrice: '25500000' },
        { mint: cards[2].mint },
      ],
    });
    // the wizard never asked for a signature or a wallet: only the session-cookie API was called
    expect(calls.every((c) => c.url.startsWith('/api/'))).toBe(true);
  });

  it('keeps Publish off when the fresh read says a card left the wallet', async () => {
    let reads = 0;
    // the first read (picker) is fine; by the second (readiness check) the card has been sent away
    stubFetch({ 'GET /api/sell/assets': () => (reads++ === 0 ? walletAnswer() : walletAnswer((a) => (a === cards[1] ? { eligible: false, reasons: ['not_owner'] } : {}))) });
    let s = await pickAll();
    expect(s.lots).toHaveLength(3);
    const fresh = await getSellAssets();
    s = applyAssets(s, fresh.ok ? fresh.data.assets : []);
    expect(allReady(s)).toBe(false);
    expect(s.readiness[cards[1].mint]).toEqual({ kind: 'blocked', reasons: ['not_owner'] });
    expect(buildCreateRequest(s, NOW)).toBeNull();
  });

  it('answers rpc_unavailable for the wallet read as an error, never as an empty wallet', async () => {
    stubFetch({ 'GET /api/sell/assets': { status: 503, body: { ok: false, code: 'rpc_unavailable', reason: 'down' } } });
    expect(await getSellAssets()).toMatchObject({ ok: false, status: 503, code: 'rpc_unavailable' });
  });

  it('carries the server refusal of the publish to the page (daily show limit, card gone)', async () => {
    stubFetch({
      'GET /api/sell/assets': walletAnswer(),
      'POST /api/shows': { status: 429, body: { ok: false, code: 'rate_limited', reason: 'limit of 3 shows per day', retryAfterS: 7200 } },
    });
    const s0 = await pickAll();
    const fresh = await getSellAssets();
    const s = applyAssets(s0, fresh.ok ? fresh.data.assets : []);
    const r = await createShow(buildCreateRequest(s, NOW)!);
    expect(r).toMatchObject({ ok: false, status: 429, code: 'rate_limited', retryAfterS: 7200 });
  });

  it('remembers the created show for the manage link', async () => {
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    const created = fixture<{ show: { id: string; title: string } }>('show-detail').show;
    rememberShow({ id: created.id, title: created.title }, 1, store);
    expect(readRecent(store)).toEqual([{ id: created.id, title: created.title, at: 1 }]);
  });
});
