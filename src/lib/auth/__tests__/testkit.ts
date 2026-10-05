/** Shared test helpers: real ed25519 keys and signatures, no mocks of the crypto. */
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { toBase64 } from '../ed25519';
import { buildBidIntent, buildPaddleAuth, type BidIntentFields, type PaddleAuthFields } from '../intent';

export const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
export const SHOW = '3f6c1f2e-9b0a-4f43-8a52-1d7a0c5e7b10';
export const LOT = '8a1b7c40-52de-4a6f-b3e1-0c9d2f4a6e11';
export const PADDLE = 'a4f1c8e3-5b27-4d09-96ae-8c3d7e1b2f18';

export interface Actor { wallet: string; sign: (text: string) => string; secretKey: Uint8Array }

export function actor(): Actor {
  const kp = nacl.sign.keyPair();
  return {
    wallet: bs58.encode(kp.publicKey),
    secretKey: kp.secretKey,
    sign: (text) => toBase64(nacl.sign.detached(new TextEncoder().encode(text), kp.secretKey)),
  };
}

export const bidFields = (bidder: string, over: Partial<BidIntentFields> = {}): BidIntentFields => ({
  cluster: 'devnet', show: SHOW, lot: LOT, amount: '120000000', bidder, paddle: PADDLE, nonce: '9f2c41d07a3be685', issued: NOW, ...over,
});

export const paddleFields = (wallet: string, session: string, over: Partial<PaddleAuthFields> = {}): PaddleAuthFields => ({
  cluster: 'devnet', show: SHOW, wallet, session, max: 500_000_000n, valid: NOW + 3_600_000, ...over,
});

/** A signed bid request. `signer` picks which key signs. */
export function signedBid(signerActor: Actor, bidder: string, signer: 'wallet' | 'session', over: Partial<BidIntentFields> = {}) {
  const message = buildBidIntent(bidFields(bidder, over));
  const f = bidFields(bidder, over);
  return { lotId: f.lot, amount: f.amount, intent: { message, signature: signerActor.sign(message), signer } } as const;
}

export { buildBidIntent, buildPaddleAuth };
