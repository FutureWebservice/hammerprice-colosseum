import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import { toBase64 } from '@/lib/client/bidder';
import { bidLogHash, type PublicBid } from '@/lib/client/settle';
import { verifyAll, type VerifyData } from '@/components/room/verifyData';

const LOT = '11111111-1111-4111-8111-111111111111';
const kp = nacl.sign.keyPair();
const pub = bs58.encode(kp.publicKey);

function bid(id: string, amount: string, at: string, over: Partial<PublicBid> = {}): PublicBid {
  const message = `hammerprice bid v1\nlot: ${LOT}\namount: ${amount}\nnonce: ${id}`;
  return { id, amount, placedAt: at, paddle: 7, message, signature: toBase64(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey)), signer: 'session', signerPubkey: pub, ...over };
}
const data = (bids: PublicBid[], hash: string | null): VerifyData => ({
  lot: { id: LOT, number: 3, name: 'Charizard', showId: '22222222-2222-4222-8222-222222222222' },
  bids,
  settlement: hash === null ? null : { id: 's', bidLogHash: hash, txSignature: null, cluster: 'devnet' },
});

describe('verifyAll', () => {
  const bids = [bid('a', '10', '2026-10-01T10:00:00Z'), bid('b', '12', '2026-10-01T10:00:05Z')];

  it('matches when the committed hash equals the recomputed one', async () => {
    const r = await verifyAll(data(bids, await bidLogHash(bids)));
    expect(r.match).toBe(true);
    expect([...r.checks.values()]).toEqual(['valid', 'valid']);
  });
  it('flags a changed signed text: hash differs and the signature fails', async () => {
    const good = await bidLogHash(bids);
    const r = await verifyAll(data([bids[0], { ...bids[1], message: bids[1].message.replace('amount: 12', 'amount: 13') }], good));
    expect(r.match).toBe(false);
    expect(r.checks.get('b')).toBe('bad_signature');
  });
  it('flags a row whose shown amount differs from the signed one (hash still matches)', async () => {
    const r = await verifyAll(data([bids[0], { ...bids[1], amount: '13' }], await bidLogHash(bids)));
    expect(r.match).toBe(true);
    expect(r.checks.get('b')).toBe('mismatch');
  });
  it('flags a forged signature', async () => {
    const forged = [bid('a', '10', '2026-10-01T10:00:00Z', { signerPubkey: bs58.encode(nacl.sign.keyPair().publicKey) })];
    expect((await verifyAll(data(forged, null))).checks.get('a')).toBe('bad_signature');
  });
  it('has no match result without a settlement', async () => {
    expect((await verifyAll(data(bids, null))).match).toBeNull();
  });
});
