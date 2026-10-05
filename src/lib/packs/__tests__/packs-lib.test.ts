/**
 * The pack library: commitment, draw selection, the recompute-it-yourself check, the rarity look. Both clusters, no network, no database.
 */
import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { sha512 } from '@noble/hashes/sha2';
import { generateVrfKey } from '@/lib/vrf/key';
import { toHex } from '@/lib/vrf';
import { drawParamsHash, packDeliveryMemo, PACK_DELIVERY_MEMO_RE, PACK_MEMO_RE } from '@/lib/packs/commit';
import {
  drawParams, formatBps, isPackProven, makeDraw, oddsHashOf, packDrawSubject, packMemo, poolHashOf, rarityOf, selectFromPool, verifyPackDraw,
  type PackDefinition, type ProofDraw, type ProofPool,
} from '@/lib/packs';
import { MAINNET_USDC_MINT } from '@/lib/chain/config';

const addr = () => Keypair.generate().publicKey.toBase58();
const beaconHash = bs58.encode(sha512(new TextEncoder().encode('block')).slice(0, 32));
const BEACON = { slot: 123_456_789, blockhash: beaconHash };
const PACK = 'aaaaaaaa-0000-4000-8000-000000000001';
const REQ = 'aaaaaaaa-0000-4000-8000-000000000002';
const SEED = '00112233445566778899aabbccddeeff';

function definition(cluster: 'devnet' | 'mainnet-beta'): PackDefinition {
  const tiers = ['common', 'rare', 'legendary'];
  const cards = [
    ...Array.from({ length: 6 }, () => ({ asset: addr(), tier: 'common', value: '25000000' })),
    ...Array.from({ length: 3 }, () => ({ asset: addr(), tier: 'rare', value: '60000000' })),
    { asset: addr(), tier: 'legendary', value: '1000000000' },
  ];
  return { mode: 'chance', cluster, price: '10000000', operator: addr(), odds: [{ tier: tiers[0]!, bps: 7000 }, { tier: tiers[1]!, bps: 2800 }, { tier: tiers[2]!, bps: 200 }], cards };
}
const outputFor = (n: number) => sha512(new TextEncoder().encode(`sample-${n}`));

describe('commitment', () => {
  const def = definition('devnet');
  it('is deterministic and covers every field a buyer relies on', () => {
    const h = poolHashOf(def);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(poolHashOf({ ...def, cards: [...def.cards] })).toBe(h);
    const variants: PackDefinition[] = [
      { ...def, price: '10000001' },
      { ...def, operator: addr() },
      { ...def, mode: 'equal_value' },
      { ...def, cluster: 'mainnet-beta' },
      { ...def, odds: [{ tier: 'common', bps: 6999 }, def.odds[1]!, { tier: 'legendary', bps: 201 }] },
      { ...def, cards: [{ ...def.cards[0]!, asset: addr() }, ...def.cards.slice(1)] },
      { ...def, cards: [{ ...def.cards[0]!, tier: 'rare' }, ...def.cards.slice(1)] },
      { ...def, cards: [{ ...def.cards[0]!, value: '1' }, ...def.cards.slice(1)] },
      { ...def, cards: [...def.cards].reverse() }, // the position of a card is part of the commitment
      { ...def, cards: def.cards.slice(1) },
    ];
    for (const v of variants) expect(poolHashOf(v)).not.toBe(h);
  });
  it('hashes the odds alone, and the memo ties a draw to the pool', () => {
    expect(oddsHashOf(def.odds)).toMatch(/^[0-9a-f]{64}$/);
    expect(oddsHashOf([...def.odds].reverse())).not.toBe(oddsHashOf(def.odds));
    expect(packMemo(REQ, poolHashOf(def))).toBe(`hp:pack:${REQ}:${poolHashOf(def)}`);
  });
  it('draw parameters sort and de-duplicate the taken positions and refuse malformed input', () => {
    const p = drawParams({ buyer: addr(), index: 3, pack: PACK, poolHash: poolHashOf(def), seed: SEED, taken: [5, 1, 5, 2] });
    expect(p.taken).toEqual([1, 2, 5]);
    expect(() => drawParams({ buyer: 'x', index: -1, pack: PACK, poolHash: poolHashOf(def), seed: SEED, taken: [] })).toThrow();
    expect(() => drawParams({ buyer: 'x', index: 0, pack: PACK, poolHash: poolHashOf(def), seed: 'ZZ', taken: [] })).toThrow();
    expect(() => drawParams({ buyer: 'x', index: 0, pack: PACK, poolHash: 'abc', seed: SEED, taken: [] })).toThrow();
    expect(() => drawParams({ buyer: 'x', index: 0, pack: PACK, poolHash: poolHashOf(def), seed: SEED, taken: [-1] })).toThrow();
  });
  it('a pay-first draw commits to its payment: the signature and slot are part of the hashed parameters, an atomic draw is unchanged', () => {
    const base = { buyer: addr(), index: 0, pack: PACK, poolHash: poolHashOf(def), seed: SEED, taken: [] as number[] };
    const sigA = bs58.encode(new Uint8Array(64).fill(1)), sigB = bs58.encode(new Uint8Array(64).fill(2));
    const atomic = drawParams(base);
    expect('payment' in atomic).toBe(false);
    const a = drawParams({ ...base, payment: { signature: sigA, slot: 10 } });
    expect(a.payment).toEqual({ signature: sigA, slot: 10 });
    expect(drawParamsHash(a)).not.toBe(drawParamsHash(atomic));
    expect(drawParamsHash(a)).not.toBe(drawParamsHash(drawParams({ ...base, payment: { signature: sigB, slot: 10 } })));
    expect(drawParamsHash(a)).not.toBe(drawParamsHash(drawParams({ ...base, payment: { signature: sigA, slot: 11 } })));
    expect(() => drawParams({ ...base, payment: { signature: 'short', slot: 10 } })).toThrow();
    expect(() => drawParams({ ...base, payment: { signature: sigA, slot: 0 } })).toThrow();
  });
  it('the delivery memo names exactly one draw and is not a payment memo', () => {
    expect(packDeliveryMemo(REQ)).toBe(`hp:pack-card:${REQ}`);
    expect(PACK_DELIVERY_MEMO_RE.exec(packDeliveryMemo(REQ))![1]).toBe(REQ);
    expect(PACK_MEMO_RE.test(packDeliveryMemo(REQ))).toBe(false);
  });
});

describe('selection', () => {
  const def = definition('devnet');
  it('follows the published odds when every tier is in stock (chi-square over 20 000 draws)', () => {
    const n = 20_000, counts: Record<string, number> = { common: 0, rare: 0, legendary: 0 };
    for (let i = 0; i < n; i++) counts[selectFromPool(outputFor(i), def.odds, def.cards, [])!.tier]!++;
    let chi = 0;
    for (const o of def.odds) { const e = (n * o.bps) / 10_000; chi += (counts[o.tier]! - e) ** 2 / e; }
    expect(chi).toBeLessThan(13.8); // 2 degrees of freedom, p = 0.001
  });
  it('picks every card of a tier with equal probability', () => {
    const n = 12_000, counts = new Map<number, number>();
    for (let i = 0; i < n; i++) { const s = selectFromPool(outputFor(100_000 + i), [{ tier: 'common', bps: 10_000 }], def.cards.filter((c) => c.tier === 'common'), [])!; counts.set(s.position, (counts.get(s.position) ?? 0) + 1); }
    const e = n / 6; let chi = 0;
    for (let p = 0; p < 6; p++) chi += ((counts.get(p) ?? 0) - e) ** 2 / e;
    expect(chi).toBeLessThan(20.5); // 5 degrees of freedom, p = 0.001
  });
  it('never returns a taken card, and renormalises when a tier is gone', () => {
    const taken = [9]; // the only legendary
    for (let i = 0; i < 400; i++) {
      const s = selectFromPool(outputFor(i), def.odds, def.cards, taken)!;
      expect(s.tier).not.toBe('legendary');
      expect(taken).not.toContain(s.position);
      expect(s.tierTotal).toBe(9800);
    }
    const allTaken = def.cards.map((_, p) => p);
    expect(selectFromPool(outputFor(1), def.odds, def.cards, allTaken)).toBeNull();
  });
  it('is a pure function of the output', () => {
    expect(selectFromPool(outputFor(7), def.odds, def.cards, [0, 1])).toEqual(selectFromPool(outputFor(7), def.odds, def.cards, [0, 1]));
  });
  it('an equal-value pack (one tier) is a uniform pick from what is left', () => {
    const one = def.cards.map((c) => ({ ...c, tier: 'all' }));
    const s = selectFromPool(outputFor(3), [{ tier: 'all', bps: 10_000 }], one, [0, 1, 2])!;
    expect(s.position).toBeGreaterThanOrEqual(3);
    expect(s.candidates).toBe(7);
  });
});

describe.each([['devnet'], ['mainnet-beta']] as const)('recompute it yourself on %s', (cluster) => {
  const key = generateVrfKey().key;
  const def = definition(cluster);
  const poolHash = poolHashOf(def);
  const buyer = addr();
  const pool: ProofPool = { ...def, poolHash, removed: [] };

  function drawAt(index: number, taken: number[]) {
    const requestId = packDrawSubject(PACK, index);
    const m = makeDraw({ cluster, packId: PACK, poolHash, def, buyer, seed: SEED, index, taken, beacon: BEACON, prove: (a) => key.prove(a) });
    const sel = m.selection!;
    const draw: ProofDraw = {
      id: `bbbbbbbb-0000-4000-8000-${String(index).padStart(12, '0')}`, packId: PACK, drawIndex: index, buyer, clientSeed: SEED, poolHash, status: 'settled',
      tier: sel.tier, cardAsset: def.cards[sel.position]!.asset,
      vrf: { requestId, input: m.alphaText, proofHex: m.proof.proofHex, outputHex: m.proof.outputHex, params: m.params as unknown as Record<string, unknown>, paramsHash: m.paramsHash, beacon: BEACON, publicKey: key.publicKey },
    };
    return { m, draw, position: sel.position };
  }
  const status = (c: Awaited<ReturnType<typeof verifyPackDraw>>) => Object.fromEntries(c.map((x) => [x.id, x.status]));

  it('an honest draw passes every cryptographic rule and the log rule, and is "proven"', async () => {
    const d0 = drawAt(0, []);
    const d1 = drawAt(1, [d0.position]);
    const checks = await verifyPackDraw(pool, d1.draw, { earlier: [{ drawIndex: 0, status: 'settled', cardAsset: d0.draw.cardAsset }] });
    expect(status(checks)).toEqual({ pool_hash: 'pass', params: 'pass', alpha: 'pass', proof: 'pass', output: 'pass', result: 'pass', taken: 'pass', beacon: 'skipped', payment: 'skipped', order: 'skipped' }); // an atomic draw has no separate payment to check
    expect(isPackProven(checks)).toBe(true);
    expect(d1.m.alphaText).toContain(`cluster: ${cluster}`);
    expect(d1.m.alphaText).toContain('purpose: pack_pull');
  });

  it('the beacon is checked against the chain when a reader is given, and an unreachable chain is unverifiable, never a green tick', async () => {
    const d0 = drawAt(0, []);
    const ok = await verifyPackDraw(pool, d0.draw, { earlier: [], rpc: { getBlockhash: async () => beaconHash, getTx: async () => null, getBlocks: async () => [], getSignatures: async () => [] } });
    expect(status(ok).beacon).toBe('pass');
    const wrong = await verifyPackDraw(pool, d0.draw, { rpc: { getBlockhash: async () => addr(), getTx: async () => null, getBlocks: async () => [], getSignatures: async () => [] } });
    expect(status(wrong).beacon).toBe('fail');
    const down = await verifyPackDraw(pool, d0.draw, { rpc: { getBlockhash: async () => { throw new Error('rpc down'); }, getTx: async () => null, getBlocks: async () => [], getSignatures: async () => [] } });
    expect(status(down).beacon).toBe('unverifiable');
    const gone = await verifyPackDraw(pool, d0.draw, { rpc: { getBlockhash: async () => null, getTx: async () => null, getBlocks: async () => [], getSignatures: async () => [] } });
    expect(status(gone).beacon).toBe('unverifiable');
  });

  describe('tampering is caught by the rule that owns it', () => {
    const d0 = drawAt(0, []);
    const run = (pool2: ProofPool, draw: ProofDraw, earlier: { drawIndex: number; status: string; cardAsset: string | null }[] = []) => verifyPackDraw(pool2, draw, { earlier });
    const clone = (d: ProofDraw, patch: Partial<Omit<ProofDraw, 'vrf'>> & { vrf?: Partial<ProofDraw['vrf']> }): ProofDraw => ({ ...d, ...patch, vrf: { ...d.vrf, ...(patch.vrf ?? {}) } });

    it('a swapped card, a changed price or another operator breaks the pool hash', async () => {
      for (const p of [{ ...pool, cards: [{ ...pool.cards[0]!, asset: addr() }, ...pool.cards.slice(1)] }, { ...pool, price: '1' }, { ...pool, operator: addr() }, { ...pool, odds: [{ tier: 'common', bps: 6000 }, pool.odds[1]!, { tier: 'legendary', bps: 1200 }] }]) {
        expect(status(await run(p, d0.draw)).pool_hash).toBe('fail');
      }
    });
    it('a draw that names another pool hash fails', async () => {
      expect(status(await run(pool, clone(d0.draw, { poolHash: '0'.repeat(64) }))).pool_hash).toBe('fail');
    });
    it('changed parameters (seed, index, buyer, taken) break the params rule', async () => {
      const p = d0.m.params as unknown as Record<string, unknown>;
      for (const patch of [{ seed: 'ff'.repeat(16) }, { index: 9 }, { buyer: addr() }, { taken: [0] }]) {
        const draw = clone(d0.draw, { vrf: { params: { ...p, ...patch } } });
        expect(status(await run(pool, draw)).params).toBe('fail');
      }
      expect(status(await run(pool, clone(d0.draw, { clientSeed: 'ee'.repeat(16) }))).params).toBe('fail'); // the draw says another seed than the parameters
    });
    it('the subject is a pure function of pack id and draw index (lowercase uuid, stable, distinct)', () => {
      expect(packDrawSubject(PACK, 0)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(packDrawSubject(PACK, 0)).toBe(packDrawSubject(PACK, 0));
      expect(packDrawSubject(PACK, 0)).not.toBe(packDrawSubject(PACK, 1));
      expect(packDrawSubject(PACK, 0)).not.toBe(packDrawSubject(REQ, 0));
    });
    it('another input text, request id or beacon breaks the alpha rule', async () => {
      expect(status(await run(pool, clone(d0.draw, { vrf: { input: d0.draw.vrf.input!.replace(/subject: \S+/, `subject: ${REQ}`) } }))).alpha).toBe('fail');
      expect(status(await run(pool, clone(d0.draw, { vrf: { requestId: REQ } }))).alpha).toBe('fail');
      // A subject the server picked (instead of the one derived from pack id and draw index) is rejected even with a valid proof for it.
      const input = d0.draw.vrf.input!.replace(/subject: \S+/, `subject: ${REQ}`), ground = key.prove(input);
      expect(status(await run(pool, clone(d0.draw, { vrf: { requestId: REQ, input, proofHex: ground.proofHex, outputHex: ground.outputHex } }))).alpha).toBe('fail');
      expect(status(await run(pool, clone(d0.draw, { vrf: { beacon: { slot: 1, blockhash: beaconHash } } }))).alpha).toBe('fail');
      expect(status(await run(pool, clone(d0.draw, { vrf: { input: 'not an alpha' } }))).alpha).toBe('fail');
    });
    it('a flipped proof bit, another key or a changed output break the proof and output rules', async () => {
      const flipped = d0.draw.vrf.proofHex!.replace(/^./, (c) => (c === '0' ? '1' : '0'));
      expect(status(await run(pool, clone(d0.draw, { vrf: { proofHex: flipped } }))).proof).toBe('fail');
      expect(status(await run(pool, clone(d0.draw, { vrf: { publicKey: generateVrfKey().key.publicKey } }))).proof).toBe('fail');
      const out = clone(d0.draw, { vrf: { outputHex: toHex(sha512(new TextEncoder().encode('other'))) } });
      const c = status(await run(pool, out));
      expect(c.proof).toBe('pass');
      expect(c.output).toBe('fail');
      expect(c.result).toBe('skipped');
    });
    it('another tier or card than the output selects breaks the result rule', async () => {
      const other = pool.cards.find((c) => c.asset !== d0.draw.cardAsset)!.asset;
      expect(status(await run(pool, clone(d0.draw, { cardAsset: other }))).result).toBe('fail');
      const otherTier = pool.odds.find((o) => o.tier !== d0.draw.tier)!.tier; // the drawn tier depends on the (random) test key, so never hard-code one
      expect(status(await run(pool, clone(d0.draw, { tier: otherTier }))).result).toBe('fail');
    });
    it('the log rule: an excluded card nobody holds, or a settled card that was not excluded, fails; a short log is unverifiable', async () => {
      const first = drawAt(0, []);
      const second = drawAt(1, [first.position]);
      const log = [{ drawIndex: 0, status: 'settled', cardAsset: first.draw.cardAsset }];
      expect(status(await run(pool, second.draw, log)).taken).toBe('pass');
      // the settled card of draw 0 is missing from `taken`: the server tries to make it available again
      const cheat = drawAt(1, []);
      expect(status(await run(pool, cheat.draw, log)).taken).toBe('fail');
      // a position excluded without any earlier draw holding it (the server removes a card from the game)
      const stray = drawAt(1, [first.position, (first.position + 1) % pool.cards.length]);
      expect(status(await run(pool, stray.draw, log)).taken).toBe('fail');
      // a card removed from the pool is a legitimate exclusion
      const removedPos = (first.position + 1) % pool.cards.length;
      expect(status(await run({ ...pool, removed: [removedPos] }, stray.draw, log)).taken).toBe('pass');
      expect(status(await run(pool, second.draw, [])).taken).toBe('unverifiable');
      expect(status(await verifyPackDraw(pool, second.draw)).taken).toBe('skipped');
    });
    it('a draw still waiting for its payment shows nothing and is never "proven"', async () => {
      const hidden = clone(d0.draw, { tier: null, cardAsset: null, vrf: { input: null, proofHex: null, outputHex: null, params: null, paramsHash: null, publicKey: null } });
      const checks = await run(pool, hidden);
      expect(checks.every((c) => c.status === 'skipped')).toBe(true);
      expect(isPackProven(checks)).toBe(false);
    });
  });

  it('refuses a cluster mismatch: an alpha made for the other cluster never verifies here', async () => {
    const other = cluster === 'devnet' ? 'mainnet-beta' : 'devnet';
    const m = makeDraw({ cluster: other, packId: PACK, poolHash, def, buyer, seed: SEED, index: 0, taken: [], beacon: BEACON, prove: (a) => key.prove(a) });
    const draw: ProofDraw = {
      id: 'bbbbbbbb-0000-4000-8000-0000000000ff', packId: PACK, drawIndex: 0, buyer, clientSeed: SEED, poolHash, status: 'settled', tier: m.selection!.tier, cardAsset: def.cards[m.selection!.position]!.asset,
      vrf: { requestId: packDrawSubject(PACK, 0), input: m.alphaText, proofHex: m.proof.proofHex, outputHex: m.proof.outputHex, params: m.params as unknown as Record<string, unknown>, paramsHash: m.paramsHash, beacon: BEACON, publicKey: key.publicKey },
    };
    expect(status(await verifyPackDraw(pool, draw, { earlier: [] })).alpha).toBe('fail');
  });
});

describe('the USDC mint is not part of the commitment but the cluster is', () => {
  it('the same definition on the two clusters has two hashes (a devnet pack cannot be replayed on mainnet)', () => {
    const d = definition('devnet');
    expect(poolHashOf(d)).not.toBe(poolHashOf({ ...d, cluster: 'mainnet-beta' }));
    expect(MAINNET_USDC_MINT).toMatch(/^EPjF/);
  });
});

describe('rarity look', () => {
  it('the likeliest tier is common, the least likely the top look, from the published odds only', () => {
    expect(rarityOf([{ tier: 'a', bps: 10_000 }])).toEqual({ a: 'common' });
    expect(rarityOf([{ tier: 'a', bps: 9000 }, { tier: 'b', bps: 1000 }])).toEqual({ a: 'common', b: 'legendary' });
    expect(rarityOf([{ tier: 'r', bps: 600 }, { tier: 'u', bps: 2400 }, { tier: 'c', bps: 7000 }])).toEqual({ c: 'common', u: 'rare', r: 'legendary' });
    const five = rarityOf([{ tier: 'a', bps: 4000 }, { tier: 'b', bps: 3000 }, { tier: 'c', bps: 2000 }, { tier: 'd', bps: 900 }, { tier: 'e', bps: 100 }]);
    expect(Object.values(five)).toEqual(['common', 'uncommon', 'rare', 'epic', 'legendary']);
    const seven = rarityOf(Array.from({ length: 7 }, (_, i) => ({ tier: `t${i}`, bps: [3000, 2500, 1500, 1200, 1000, 600, 200][i]! })));
    expect(seven.t0).toBe('common');
    expect(seven.t6).toBe('legendary');
  });
  it('formats basis points as a percentage in both locales', () => {
    expect(formatBps(7000, 'en')).toBe('70 %');
    expect(formatBps(56, 'en')).toBe('0.56 %');
    expect(formatBps(56, 'de')).toBe('0,56 %');
  });
});
