/** What the API shows of a draw: the demo end (`demo_revealed`) is a finished draw, so its result, proof and card are public at once; an unpaid or undelivered-yet draw is not. */
import { describe, expect, it } from 'vitest';
import { PackDrawView } from '@/contracts';
import { drawView, gradeOf, isDrawRevealed, poolCardViews, type CardRow, type DrawRow, type PackRow, type VrfRow } from '../views';

const ID = '00000000-0000-4000-8000-0000000000aa';
const pack = { poolHash: 'ab'.repeat(32), cluster: 'devnet', operatorWallet: '1'.repeat(32), isHouse: true } as Pick<PackRow, 'poolHash' | 'cluster' | 'operatorWallet' | 'isHouse'>;
const card = { id: '00000000-0000-4000-8000-000000000001', packId: ID, asset: '3'.repeat(32), tier: 'rare', name: 'Charizard', imageUrl: 'https://example.com/c.png', listedValue: null, attributes: { grade: '10', grading_company: 'PSA' }, position: 0, status: 'available' } as unknown as CardRow;
const draw = (status: string) => ({
  id: ID, packId: ID, buyerWallet: '5'.repeat(32), cluster: 'devnet', drawIndex: 0, clientSeed: 'a'.repeat(32), status, price: 5_000_000n, flow: 'pay_first', tier: 'rare', cardId: card.id, asset: card.asset,
  txSignature: '4'.repeat(88), deliverySignature: null, createdAt: new Date('2026-10-05T12:00:00Z'), settledAt: null, paidAt: new Date(), paymentSlot: 5, deliverBy: null, undeliveredAt: null, undeliveredReason: null,
  vrfInput: 'x', proofHex: 'a'.repeat(160), outputHex: 'b'.repeat(128), settlementRef: null,
}) as unknown as DrawRow;
const vrf = { id: '00000000-0000-4000-8000-0000000000bb', status: 'revealed', params: {}, paramsHash: 'f'.repeat(64), beaconSlot: 6, beaconBlockhash: 'h'.repeat(40), publicKey: '2'.repeat(32) } as unknown as VrfRow;

describe('draw views', () => {
  it('demo_revealed is a finished draw: revealed, with the card (name, grade), tier and proof, no delivery, no deadline', () => {
    expect(isDrawRevealed('demo_revealed')).toBe(true);
    const v = PackDrawView.parse(drawView(draw('demo_revealed'), pack, vrf, card));
    expect(v).toMatchObject({ status: 'demo_revealed', revealed: true, tier: 'rare', card: { name: 'Charizard', grade: 'PSA 10' }, deliverySignature: null, deliverBy: null, undeliveredReason: null });
    expect(v.vrf.proofHex).toBe('a'.repeat(160));
    expect(v.txSignature).toBe('4'.repeat(88)); // the real payment is linked
  });
  it('a paid, drawn or delivering draw still hides its result (the buyer is not shown a card that has not ended)', () => {
    for (const s of ['paid', 'drawn', 'delivering']) {
      const v = drawView(draw(s), pack, vrf, card);
      expect(isDrawRevealed(s)).toBe(false);
      expect(v).toMatchObject({ revealed: false, tier: null, card: null });
      expect(v.vrf.proofHex).toBeNull();
    }
  });
  it('the grade comes from the card attributes (company and grade), or is null', () => {
    expect(gradeOf(card)).toBe('PSA 10');
    expect(gradeOf({ attributes: { grade: '9' } } as unknown as CardRow)).toBe('9');
    expect(gradeOf({ attributes: { grade: 'PSA 9', grading_company: 'PSA' } } as unknown as CardRow)).toBe('PSA 9'); // not doubled
    expect(gradeOf({ attributes: null } as unknown as CardRow)).toBeNull();
    expect(poolCardViews([card])[0]!.grade).toBe('PSA 10');
  });
});
