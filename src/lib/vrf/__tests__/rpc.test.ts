import { describe, expect, it } from 'vitest';
import { createFetchRpc, parseSigMemo } from '../rpc';
import { verifyRequest } from '../verify';
import { makeWorld } from './testkit';

describe('parseSigMemo', () => {
  it('strips the length prefix and splits several memos', () => {
    expect(parseSigMemo('[9] hp:vrf:d1:x')).toEqual(['hp:vrf:d1:x']);
    expect(parseSigMemo('[3] abc; [4] defg')).toEqual(['abc', 'defg']);
    expect(parseSigMemo(null)).toEqual([]);
  });
});

/** The JSON-RPC client against a stub server that answers like the Solana RPC does. */
describe('createFetchRpc', () => {
  it('speaks finalized JSON-RPC and normalises transactions, blocks and signatures; the full check passes through it', async () => {
    const w = makeWorld();
    const seen: { method: string; params: unknown[] }[] = [];
    const fake: typeof fetch = async (_u, init) => {
      const { method, params, id } = JSON.parse(String(init!.body)) as { method: string; params: unknown[]; id: number };
      seen.push({ method, params });
      let result: unknown;
      if (method === 'getTransaction') {
        const t = w.rpc.txs.get(params[0] as string)!;
        result = { slot: t.slot, blockTime: t.blockTime, meta: { err: null }, transaction: { message: {
          accountKeys: [...t.signers.map((pubkey) => ({ pubkey, signer: true })), { pubkey: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', signer: false }],
          instructions: t.memos.map((m) => ({ program: 'spl-memo', parsed: m })).concat([{ program: 'system', parsed: { x: 1 } as never }]),
        } } };
      } else if (method === 'getBlocks') result = w.rpc.blocks;
      else if (method === 'getBlock') result = { blockhash: w.rpc.hashes.get(params[0] as number) };
      else if (method === 'getSignaturesForAddress') result = w.rpc.sigs.map((s) => ({ signature: s.signature, slot: s.slot, blockTime: s.blockTime, err: null, memo: s.memos.map((m) => `[${m.length}] ${m}`).join('; ') }));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200 });
    };
    const rpc = createFetchRpc('https://rpc.example', { fetch: fake });
    const cs = await verifyRequest(w.view, { rpc });
    expect(cs.map((c) => c.status)).toEqual(Array(9).fill('pass'));
    expect(seen.every((s) => JSON.stringify(s.params).includes('finalized'))).toBe(true);
    expect(seen.map((s) => s.method)).toEqual(expect.arrayContaining(['getTransaction', 'getBlocks', 'getBlock', 'getSignaturesForAddress']));
  });
  it('turns HTTP errors and RPC errors into thrown errors (so the rule becomes "unverifiable")', async () => {
    const down = createFetchRpc('https://rpc.example', { fetch: async () => new Response('x', { status: 503 }) });
    await expect(down.getBlocks(1, 2)).rejects.toThrow(/HTTP 503/);
    const err = createFetchRpc('https://rpc.example', { fetch: async () => new Response(JSON.stringify({ error: { code: -32007, message: 'Slot 5 was skipped' } })) });
    await expect(err.getBlocks(1, 2)).rejects.toThrow(/skipped/);
    await expect(err.getBlockhash(5)).resolves.toBeNull(); // a skipped block is "unknown", not a transport failure
    const w = makeWorld();
    const cs = await verifyRequest(w.view, { rpc: down });
    expect(cs.slice(5).map((c) => c.status)).toEqual(Array(4).fill('unverifiable'));
  });
});
