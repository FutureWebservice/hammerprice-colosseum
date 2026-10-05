/**
 * Every money route fails closed on an unusable cluster configuration, BEFORE it reads a row, a session or the chain:
 * bids and buy-now (authorizeIntent), paddles, creating a show. No database is needed: the guard is the first thing they do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, ERROR_STATUS, type BidRequest } from '@/contracts';
import { authorizeIntent } from '../intent';

const KEYS = ['SOLANA_CLUSTER', 'NEXT_PUBLIC_SOLANA_NETWORK', 'SOLANA_RPC_URL', 'SETTLEMENT_AUTHORITY_SECRET_KEY', 'PLATFORM_WALLET_ADDRESS', 'USDC_MINT', 'FAUCET_MINT_AUTHORITY_SECRET_KEY'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
beforeEach(() => { for (const k of KEYS) delete process.env[k]; vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } vi.restoreAllMocks(); });

const SHOW = '3f6c1f2e-9b0a-4f43-8a52-1d7a0c5e7b10';
const LOT = '8a1b7c40-52de-4a6f-b3e1-0c9d2f4a6e11';
const post = (path: string, body: unknown) => new Request(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(body) });

const incompleteMainnet = () => { process.env.SOLANA_CLUSTER = 'mainnet-beta'; };
const contradiction = () => { process.env.SOLANA_CLUSTER = 'devnet'; process.env.NEXT_PUBLIC_SOLANA_NETWORK = 'mainnet-beta'; };

describe('money routes on an unusable cluster configuration', () => {
  for (const [label, setup, code] of [['incomplete mainnet', incompleteMainnet, 'mainnet_config_incomplete'], ['contradicting cluster variables', contradiction, 'cluster_config_conflict']] as const) {
    it(`bids and buy-now refuse (${label}): ${code}, 503, before any lookup`, async () => {
      setup();
      const request = { lotId: LOT, amount: '60000000', intent: { message: 'x', signature: 'y'.repeat(88), signer: 'wallet' } } as unknown as BidRequest;
      await expect(authorizeIntent(post('/api/bids', request), request, { bucket: 'bid' })).rejects.toMatchObject({ code, status: 503 });
      await expect(authorizeIntent(post('/api/bids', request), request, { bucket: 'buy-now', walletOnly: true })).rejects.toBeInstanceOf(ApiError);
    });

    it(`registering a paddle refuses (${label})`, async () => {
      setup();
      const { POST } = await import('@/app/api/shows/[id]/paddle/route');
      const res = await POST(post(`/api/shows/${SHOW}/paddle`, {}), { params: Promise.resolve({ id: SHOW }) });
      expect(res.status).toBe(ERROR_STATUS[code]);
      expect(await res.json()).toMatchObject({ ok: false, code });
    });

    it(`creating a show refuses (${label})`, async () => {
      setup();
      const { POST } = await import('@/app/api/shows/route');
      const res = await POST(post('/api/shows', {}));
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ ok: false, code });
    });
  }

  it('a complete devnet default is not refused by the guard (it goes on to the next check)', async () => {
    const request = { lotId: LOT, amount: '60000000', intent: { message: 'not a bid intent', signature: 'y'.repeat(88), signer: 'wallet' } } as unknown as BidRequest;
    await expect(authorizeIntent(post('/api/bids', request), request, { bucket: 'bid' })).rejects.toMatchObject({ code: 'bad_signature' }); // the intent parser, not the cluster guard
  });
});
