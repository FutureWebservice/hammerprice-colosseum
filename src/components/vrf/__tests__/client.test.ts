/**
 * The browser-side helpers with a fake fetch: how the API answers are read (feature off, not found, error), the verifier wiring (five
 * browser rules, all nine through the cluster's public RPC), tampering, and which RPC each cluster is read from.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeWorld, type World } from '@/lib/vrf/__tests__/testkit';
import { fetchKey, fetchLotNames, fetchRequest, fetchShowDraws, postAdvance, proofPackage, provenLocally, rpcUrlFor, runAll, runCrypto } from '../client';

afterEach(() => { vi.unstubAllEnvs(); });
const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('reading the API', () => {
  it('ok, feature_off, not_found, and error for anything else (including a thrown fetch)', async () => {
    expect(await fetchRequest('x', async () => res(200, { id: 'x' }))).toEqual({ kind: 'ok', value: { id: 'x' } });
    expect(await fetchRequest('x', async () => res(404, { ok: false, code: 'feature_off' }))).toEqual({ kind: 'off' });
    expect(await fetchRequest('x', async () => res(404, { ok: false, code: 'not_found' }))).toEqual({ kind: 'not_found' });
    expect(await fetchRequest('x', async () => res(500, {}))).toEqual({ kind: 'error' });
    expect(await fetchRequest('x', async () => { throw new Error('offline'); })).toEqual({ kind: 'error' });
    expect(await fetchKey(async () => res(404, { code: 'feature_off' }))).toEqual({ kind: 'off' });
  });

  it('advance is a POST with an empty JSON body to the right path', async () => {
    const f = vi.fn(async (url: string, init?: RequestInit) => { void url; void init; return res(200, { id: 'x' }); });
    await postAdvance('a b', f as never);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/vrf/requests/a%20b/advance');
    expect(init).toMatchObject({ method: 'POST', body: '{}' });
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('show draws and lot names degrade to null and {} when the calls fail', async () => {
    expect(await fetchShowDraws('s', async () => res(404, {}))).toBeNull();
    expect(await fetchShowDraws('s', async () => res(200, { lotOrder: { requestId: 'r', status: 'revealed' }, raffle: null }))).toEqual({ lotOrder: { requestId: 'r', status: 'revealed' }, raffle: null });
    expect(await fetchLotNames('s', async () => res(500, {}))).toEqual({});
    expect(await fetchLotNames('s', async () => res(200, { lots: [{ id: 'l1', name: 'Charizard' }] }))).toEqual({ l1: 'Charizard' });
    expect(await fetchLotNames('s', async () => { throw new Error('x'); })).toEqual({});
  });
});

describe('the verifier in the browser', () => {
  it('runCrypto: the five rules pass for a proper draw, and "proven" follows from them alone', async () => {
    const { view } = makeWorld();
    const checks = await runCrypto(view);
    expect(checks.map((c) => `${c.id}:${c.status}`)).toEqual(['params_hash:pass', 'alpha:pass', 'proof:pass', 'output:pass', 'result:pass', 'commit_memo:skipped', 'beacon:skipped', 'reveal_memo:skipped', 'single_commit:skipped'].slice(0, checks.length));
    expect(await provenLocally(checks)).toBe(true);
  });

  it('a proof with one flipped bit, a swapped result, or other lots are caught and never "proven"', async () => {
    const { view } = makeWorld();
    const flipped = { ...view, proofHex: (view.proofHex![0] === 'a' ? 'b' : 'a') + view.proofHex!.slice(1) };
    const swapped = { ...view, result: { ...(view.result as { order: string[] }), order: [...(view.result as { order: string[] }).order].reverse() } };
    const otherLots = { ...view, params: { ...(view.params as object), lots: (view.params as { lots: unknown[] }).lots.slice(1) } };
    for (const v of [flipped, swapped, otherLots]) {
      const c = await runCrypto(v);
      expect(c.some((x) => x.status === 'fail')).toBe(true);
      expect(await provenLocally(c)).toBe(false);
    }
  });

  it('a defaulted draw is never proven and never a failure', async () => {
    const { view } = makeWorld();
    const d = { ...view, status: 'defaulted' as const, alphaText: null, beacon: null, proofHex: null, outputHex: null, revealTx: null, result: { order: [], applied: false } };
    const c = await runCrypto(d);
    expect(c.some((x) => x.status === 'fail')).toBe(false);
    expect(await provenLocally(c)).toBe(false);
  });

  /** A JSON-RPC server over the testkit's in-memory chain. */
  const rpcFetch = (w: World, log: string[] = []) => (async (url: string, init: RequestInit) => {
    log.push(url);
    const { method, params } = JSON.parse(init.body as string) as { method: string; params: unknown[] };
    const ok = (result: unknown) => res(200, { jsonrpc: '2.0', id: 1, result });
    if (method === 'getTransaction') {
      const t = w.rpc.txs.get(params[0] as string);
      return ok(t && { slot: t.slot, blockTime: t.blockTime, meta: { err: null }, transaction: { message: { accountKeys: t.signers.map((p) => ({ pubkey: p, signer: true })), instructions: t.memos.map((m) => ({ program: 'spl-memo', parsed: m })) } } });
    }
    if (method === 'getBlocks') return ok(w.rpc.blocks.filter((s) => s >= (params[0] as number) && s <= (params[1] as number)));
    if (method === 'getBlock') return ok({ blockhash: w.rpc.hashes.get(params[0] as number) });
    if (method === 'getSignaturesForAddress') return ok(w.rpc.sigs.map((s) => ({ signature: s.signature, slot: s.slot, blockTime: s.blockTime, err: null, memo: s.memos.map((m) => `[${m.length}] ${m}`).join('; ') })));
    return res(200, { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'no such method' } });
  }) as unknown as typeof fetch;

  it('runAll: all nine rules pass through the public RPC of the draw\'s own cluster (devnet and mainnet-beta)', async () => {
    for (const cluster of ['devnet', 'mainnet-beta'] as const) {
      const w = makeWorld(cluster);
      const urls: string[] = [];
      const checks = await runAll(w.view, rpcFetch(w, urls));
      expect(checks.map((c) => c.status), cluster).toEqual(Array(9).fill('pass'));
      expect(new Set(urls)).toEqual(new Set([rpcUrlFor(cluster)]));
    }
  });

  it('runAll with the network down: the five browser rules still pass, the four network rules say "could not be checked", never a pass', async () => {
    const w = makeWorld();
    const checks = await runAll(w.view, (async () => { throw new Error('offline'); }) as unknown as typeof fetch);
    expect(checks.filter((c) => c.kind === 'crypto').every((c) => c.status === 'pass')).toBe(true);
    expect(checks.filter((c) => c.kind === 'chain').map((c) => c.status)).toEqual(Array(4).fill('unverifiable'));
    expect(await provenLocally(checks)).toBe(true); // "proven" rests on the browser rules; the network rules are shown separately
  });

  it('runAll with a chain that disagrees (a different beacon hash) fails the beacon rule', async () => {
    const w = makeWorld();
    w.rpc.hashes.set(w.view.beacon!.slot, 'DifferentHash1111111111111111111111111111111');
    const checks = await runAll(w.view, rpcFetch(w));
    expect(checks.find((c) => c.id === 'beacon')?.status).toBe('fail');
  });
});

describe('which RPC is read', () => {
  it('the public RPC of the cluster of the draw; the configured public RPC only for the deployment\'s own cluster', () => {
    expect(rpcUrlFor('devnet')).toBe('https://api.devnet.solana.com');
    expect(rpcUrlFor('mainnet-beta')).toBe('https://api.mainnet-beta.solana.com');
    vi.stubEnv('NEXT_PUBLIC_SOLANA_NETWORK', 'mainnet-beta');
    vi.stubEnv('NEXT_PUBLIC_SOLANA_RPC_PUBLIC', 'https://rpc.example.org/pub');
    expect(rpcUrlFor('mainnet-beta')).toBe('https://rpc.example.org/pub');
    expect(rpcUrlFor('devnet')).toBe('https://api.devnet.solana.com'); // never the mainnet RPC for a devnet draw
  });
});

describe('the proof package', () => {
  it('is the public view and the checks, nothing else', () => {
    const { view } = makeWorld();
    const p = JSON.parse(proofPackage(view, null)) as Record<string, unknown>;
    expect(p).toMatchObject({ format: 'hammerprice-vrf-proof', version: 1, request: { id: view.id } });
    expect(JSON.stringify(p)).not.toMatch(/b64|lease|secret/i);
  });
});
