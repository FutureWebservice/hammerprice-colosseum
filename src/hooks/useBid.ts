'use client';

/**
 * Place a binding bid: sign the intent (silently with the paddle's session key, else with the wallet), POST
 * /api/bids, fold the returned snapshot into the room. Optimistic display and its reconciliation live in
 * AuctionRoom; this hook only reports the outcome.
 */
import { useCallback, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { BidResponse, type LiveSnapshot } from '@/contracts';
import {
  bidFailureKey, buildBidIntent, classifyWalletError, newNonce, readFailure, signWithSession, toBase64, type StoredPaddle,
} from '@/lib/client/bidder';

export interface BidError { key: string; code?: string; minNext?: string; retryAfterS?: number; wallet?: 'rejected' | 'cluster' | 'unsupported' | 'unknown' }
export type BidOutcome = { ok: true; extended: boolean; closesAt: string } | { ok: false; error: BidError };

export function useBid(opts: {
  showId: string;
  cluster: string | null;
  wallet: string | null;
  paddle: StoredPaddle | null;
  /** Server-corrected clock: the intent's `issued` must be within 120 s of the server's. */
  serverNow: () => number;
  onSnapshot: (s: LiveSnapshot) => void;
}) {
  const { showId, cluster, wallet, paddle, serverNow, onSnapshot } = opts;
  const { signMessage } = useWallet();
  const [pending, setPending] = useState(false);

  const submit = useCallback(async (lotId: string, amount: bigint): Promise<BidOutcome> => {
    const fail = (error: BidError): BidOutcome => ({ ok: false, error });
    if (!wallet) return fail({ key: 'errors.unauthenticated' });
    setPending(true);
    try {
      const message = buildBidIntent({
        cluster: cluster ?? 'devnet', show: showId, lot: lotId, amount: amount.toString(), bidder: wallet,
        paddle: paddle?.paddleId ?? null, nonce: newNonce(), issued: serverNow(),
      });
      let signature: string;
      let signer: 'wallet' | 'session';
      if (paddle) {
        signature = signWithSession(paddle.secretKey, message);
        signer = 'session';
      } else {
        if (!signMessage) return fail({ key: 'errors.noSignMessage' });
        try {
          signature = toBase64(await signMessage(new TextEncoder().encode(message)));
        } catch (e) {
          return fail({ key: 'errors.walletSign', wallet: classifyWalletError(e) });
        }
        signer = 'wallet';
      }
      const res = await fetch('/api/bids', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lotId, amount: amount.toString(), intent: { message, signature, signer } }),
      });
      if (!res.ok) {
        const f = await readFailure(res);
        return fail({ key: bidFailureKey(f), code: typeof f.code === 'string' ? f.code : undefined, minNext: f.minNext, retryAfterS: f.retryAfterS });
      }
      const body = BidResponse.safeParse(await res.json().catch(() => null));
      if (!body.success) return fail({ key: 'errors.generic' });
      onSnapshot(body.data.live);
      return { ok: true, extended: body.data.extended, closesAt: body.data.closesAt };
    } catch {
      return fail({ key: 'errors.network' });
    } finally {
      setPending(false);
    }
  }, [wallet, cluster, showId, paddle, serverNow, signMessage, onSnapshot]);

  return { pending, submit };
}
