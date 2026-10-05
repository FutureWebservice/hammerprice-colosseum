/**
 * Review findings on the verify page for PAY FIRST draws (A14, third-party packs whose deliveries stay open for up to a day):
 *   - the order of the draws is the order of the payments, same slot broken by the transaction id in byte order, and a payment slot nobody can see is "unverifiable", never a silent pass,
 *   - the cards of earlier draws that are paid but not delivered yet are not public: excluded positions that belong to them are "not public yet", never a false mismatch.
 * Both clusters, no network, no database.
 */
import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { sha512 } from '@noble/hashes/sha2';
import { generateVrfKey } from '@/lib/vrf/key';
import { makeDraw, packDrawSubject, poolHashOf, verifyPackDraw, type PackDefinition, type ProofDraw, type ProofPool } from '@/lib/packs';

const addr = () => Keypair.generate().publicKey.toBase58();
const PACK = 'aaaaaaaa-0000-4000-8000-000000000011';
const SEED = '00112233445566778899aabbccddeeff';
const sig = (b: number) => bs58.encode(new Uint8Array(64).fill(b));
const hashAt = (slot: number) => bs58.encode(sha512(new TextEncoder().encode(`b-${slot}`)).slice(0, 32));

describe.each([['devnet'], ['mainnet-beta']] as const)('the verifier for pay-first draws on %s', (cluster) => {
  const key = generateVrfKey().key;
  const def: PackDefinition = {
    mode: 'chance', cluster, price: '10000000', operator: addr(), odds: [{ tier: 'common', bps: 10000 }],
    cards: Array.from({ length: 6 }, () => ({ asset: addr(), tier: 'common', value: '25000000' })),
  };
  const poolHash = poolHashOf(def);
  const pool: ProofPool = { ...def, poolHash, removed: [] };
  const buyer = addr();
  const SLOT = 500;

  function payFirstDraw(index: number, taken: number[], payment = { signature: sig(5), slot: SLOT }) {
    const beacon = { slot: payment.slot + 1, blockhash: hashAt(payment.slot + 1) };
    const m = makeDraw({ cluster, packId: PACK, poolHash, def, buyer, seed: SEED, index, taken, beacon, payment, prove: (a) => key.prove(a) });
    const sel = m.selection!;
    const draw: ProofDraw = {
      id: `cccccccc-0000-4000-8000-${String(index).padStart(12, '0')}`, packId: PACK, drawIndex: index, flow: 'pay_first', buyer, clientSeed: SEED, poolHash, status: 'settled', tier: sel.tier, cardAsset: def.cards[sel.position]!.asset,
      vrf: { requestId: packDrawSubject(PACK, index), input: m.alphaText, proofHex: m.proof.proofHex, outputHex: m.proof.outputHex, params: m.params as unknown as Record<string, unknown>, paramsHash: m.paramsHash, beacon, publicKey: key.publicKey },
    };
    return { draw, position: sel.position };
  }
  const by = (c: Awaited<ReturnType<typeof verifyPackDraw>>) => Object.fromEntries(c.map((x) => [x.id, x.status]));
  const first = payFirstDraw(0, [], { signature: sig(3), slot: SLOT });

  it('order: an earlier draw paid in an earlier slot, or in the same slot with a smaller transaction id, passes', async () => {
    const second = payFirstDraw(1, [first.position]);
    const log = (slot: number, signature: string) => [{ drawIndex: 0, status: 'settled', cardAsset: first.draw.cardAsset, paymentSlot: slot, paymentSignature: signature }];
    expect(by(await verifyPackDraw(pool, second.draw, { earlier: log(SLOT - 1, sig(9)) })).order).toBe('pass');
    expect(by(await verifyPackDraw(pool, second.draw, { earlier: log(SLOT, sig(3)) })).order).toBe('pass');
  });

  it('order: an earlier draw paid in a LATER slot fails, and so does one in the same slot with a LARGER transaction id (the tie-break is deterministic)', async () => {
    const second = payFirstDraw(1, [first.position]);
    const log = (slot: number, signature: string) => [{ drawIndex: 0, status: 'settled', cardAsset: first.draw.cardAsset, paymentSlot: slot, paymentSignature: signature }];
    expect(by(await verifyPackDraw(pool, second.draw, { earlier: log(SLOT + 1, sig(1)) })).order).toBe('fail');
    const same = await verifyPackDraw(pool, second.draw, { earlier: log(SLOT, sig(9)) });
    expect(by(same).order).toBe('fail');
    expect(same.find((c) => c.id === 'order')!.detail).toMatch(/same slot with a later transaction id/);
  });

  it('order: an earlier draw whose payment slot is not public is unverifiable, never a silent pass', async () => {
    const second = payFirstDraw(1, [first.position]);
    const checks = await verifyPackDraw(pool, second.draw, { earlier: [{ drawIndex: 0, status: 'drawn', cardAsset: null, paymentSlot: null }] });
    expect(by(checks).order).toBe('unverifiable');
  });

  it('taken: the card of an earlier draw that is paid but not delivered is not public yet: unverifiable, not a mismatch; a stray beyond that still fails', async () => {
    const second = payFirstDraw(1, [first.position]);
    const hidden = [{ drawIndex: 0, status: 'drawn', cardAsset: null, paymentSlot: SLOT, paymentSignature: sig(3) }];
    const c = await verifyPackDraw(pool, second.draw, { earlier: hidden });
    expect(by(c).taken).toBe('unverifiable');
    expect(by(c).result).toBe('pass'); // the cryptographic rules do not depend on it
    // two excluded positions but only one hidden earlier draw: one of them has no explanation
    const stray = payFirstDraw(1, [first.position, (first.position + 1) % def.cards.length]);
    expect(by(await verifyPackDraw(pool, stray.draw, { earlier: hidden })).taken).toBe('fail');
    // once the earlier draw is delivered its card is public and the same positions verify
    const shown = [{ ...hidden[0]!, status: 'settled', cardAsset: first.draw.cardAsset }];
    expect(by(await verifyPackDraw(pool, second.draw, { earlier: shown })).taken).toBe('pass');
    // an undelivered draw shows its card too (the buyer needs the proof)
    const undelivered = [{ ...hidden[0]!, status: 'undelivered', cardAsset: first.draw.cardAsset }];
    expect(by(await verifyPackDraw(pool, second.draw, { earlier: undelivered })).taken).toBe('pass');
  });
});
