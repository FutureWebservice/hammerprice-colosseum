import { afterEach, describe, expect, it, vi } from 'vitest';
import cards from '../../chain/__tests__/fixtures/cc-wallet-cards.json';
import { listByOwner } from '../collector-crypt';

afterEach(() => vi.unstubAllGlobals());
const stub = (body: unknown, status = 200) => {
  const f = vi.fn(async () => ({ ok: status < 400, status, json: async () => body }) as Response);
  vi.stubGlobal('fetch', f);
  return f;
};
const WALLET = 'HDmEm8a6CX2gSXT6m3NJZRbLmUqBSejXu3D8KkDSbhPf';

describe('listByOwner', () => {
  it('asks GET /cards/<wallet> (the marketplace endpoint rejects owner=) and sends a User-Agent', async () => {
    const f = stub(cards);
    await listByOwner(WALLET);
    const [url, init] = f.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe(`/cards/${WALLET}`);
    expect(url.searchParams.has('owner')).toBe(false);
    expect((init.headers as Record<string, string>)['user-agent']).toMatch(/hammerprice/);
  });
  it('returns Solana Core cards only, unlisted ones included, with a numeric listed price', async () => {
    stub(cards);
    const out = await listByOwner(WALLET);
    expect(out.length).toBe(cards.filterNFtCard.filter((c) => c.blockchain === 'Solana' && c.nftStandard === 'core').length);
    expect(out.every((c) => c.nftStandard === 'core')).toBe(true);
    expect(out.some((c) => c.price === null)).toBe(true);
    expect(out.find((c) => c.price !== null)!.price).toEqual(expect.any(Number));
  });
  it('refuses something that is not a wallet address before any request is made', async () => {
    const f = stub(cards);
    await expect(listByOwner('../marketplace?x=1')).rejects.toThrow(/wallet/);
    expect(f).not.toHaveBeenCalled();
  });
  it('an upstream error is an error, not an empty picker', async () => {
    stub({}, 400);
    await expect(listByOwner(WALLET)).rejects.toThrow(/400/);
  });
});
