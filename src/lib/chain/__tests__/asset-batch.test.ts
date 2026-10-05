/** readAssets: the readiness reads of a whole candidate list in two requests, with the same answers as one readAsset per card. */
import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import raw from './fixtures/cc-assets-raw.json';
import { readAsset, readAssets } from '../asset';
import type { RpcCall } from '../rpc';

type Fx = { nft: string; acctOwnerProgram: string; b64: string; std: string };
const fixtures = (raw as Fx[]).filter((r) => r.std === 'core').slice(0, 3);
const account = (r: Fx) => ({ owner: r.acctOwnerProgram, lamports: 1, data: [r.b64, 'base64'] });

/** A chain with these accounts that counts what it is asked. */
const chain = () => {
  const seen: { method: string; n: number }[] = [];
  const call = (async (method: string, params: unknown[]) => {
    if (method === 'getMultipleAccounts') {
      const a = params[0] as string[]; seen.push({ method, n: a.length });
      return { value: a.map((k) => { const f = fixtures.find((r) => r.nft === k); return f ? account(f) : null; }) };
    }
    seen.push({ method, n: 1 });
    const f = fixtures.find((r) => r.nft === params[0]);
    return { value: f ? account(f) : null };
  }) as RpcCall;
  return { call, seen };
};

describe('readAssets', () => {
  it('reads three cards (and their one collection) in two requests, lined up with the input, with the answers of readAsset', async () => {
    const { call, seen } = chain();
    const mints = fixtures.map((f) => f.nft);
    const infos = await readAssets(mints, 'devnet', call);
    expect(seen).toEqual([{ method: 'getMultipleAccounts', n: 3 }, { method: 'getMultipleAccounts', n: 1 }]);
    const single = chain();
    for (let i = 0; i < mints.length; i++) expect(infos[i]).toEqual(await readAsset(mints[i], 'devnet', single.call));
    expect(single.seen).toHaveLength(6); // one request per account is what it replaces
  });

  it('a missing account and an invalid address are null, and cost no extra request', async () => {
    const { call, seen } = chain();
    const missing = Keypair.generate().publicKey.toBase58();
    const infos = await readAssets([missing, 'not an address', fixtures[0].nft], 'devnet', call);
    expect(infos[0]).toBeNull();
    expect(infos[1]).toBeNull();
    expect(infos[2]?.mint).toBe(fixtures[0].nft);
    expect(seen[0]).toEqual({ method: 'getMultipleAccounts', n: 2 });
  });

  it('nothing to read, nothing asked', async () => {
    const { call, seen } = chain();
    expect(await readAssets([], 'devnet', call)).toEqual([]);
    expect(seen).toEqual([]);
  });
});
