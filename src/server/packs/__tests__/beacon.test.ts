import { describe, expect, it } from 'vitest';
import { ChainError } from '@/lib/chain/errors';
import type { RpcCall } from '@/lib/chain/rpc';
import { readBeacon, readBeaconAfter } from '../beacon';

const rpc = (handlers: Record<string, (p: unknown[]) => unknown>): RpcCall => (async (method: string, params: unknown[] = []) => {
  const h = handlers[method];
  if (!h) throw new Error(`unexpected ${method}`);
  return h(params);
}) as RpcCall;

describe('readBeacon', () => {
  it('reads the newest finalized block that exists and returns its slot and blockhash (finalized reads only)', async () => {
    const seen: unknown[][] = [];
    const call = rpc({
      getSlot: (p) => { seen.push(p); return 1000; },
      getBlocks: (p) => { seen.push(p); return [990, 995, 998]; },
      getBlock: (p) => { seen.push(p); return p[0] === 998 ? null : { blockhash: `hash-${p[0]}` }; }, // the newest one has been cleaned up
    });
    expect(await readBeacon(call)).toEqual({ slot: 995, blockhash: 'hash-995' });
    for (const p of seen) expect(JSON.stringify(p)).toContain('finalized');
  });
  it('fails closed when no block can be read', async () => {
    await expect(readBeacon(rpc({ getSlot: () => 5, getBlocks: () => [], getBlock: () => null }))).rejects.toBeInstanceOf(ChainError);
    await expect(readBeacon(rpc({ getSlot: () => 5, getBlocks: () => [4], getBlock: () => { throw new Error('boom'); } }))).rejects.toMatchObject({ code: 'rpc_unavailable' });
  });
});

describe('readBeaconAfter (the beacon of a pay-first draw)', () => {
  it('is the FIRST block produced after the payment slot, finalized reads only, and the server has no other choice', async () => {
    const seen: unknown[][] = [];
    const call = rpc({
      getSlot: (p) => { seen.push(p); return 1000; },
      getBlocks: (p) => { seen.push(p); return [505, 506, 520]; }, // 501 to 504 were skipped slots
      getBlock: (p) => { seen.push(p); return { blockhash: `hash-${p[0]}` }; },
    });
    expect(await readBeaconAfter(call, 500)).toEqual({ slot: 505, blockhash: 'hash-505' });
    expect(seen[1]![0]).toBe(501); // the range starts right after the payment slot
    for (const p of seen) expect(JSON.stringify(p)).toContain('finalized');
  });
  it('is null while that block is not final yet (the draw waits), never an older or luckier block', async () => {
    expect(await readBeaconAfter(rpc({ getSlot: () => 500 }), 500)).toBeNull(); // nothing finalized after the payment
    expect(await readBeaconAfter(rpc({ getSlot: () => 510, getBlocks: () => [] }), 500)).toBeNull(); // finalized slots exist but none produced a block yet
  });
  it('fails closed when the block exists but cannot be read', async () => {
    await expect(readBeaconAfter(rpc({ getSlot: () => 510, getBlocks: () => [505], getBlock: () => null }), 500)).rejects.toMatchObject({ code: 'rpc_unavailable' });
  });
});
