'use client';

/**
 * Paddle registration: the wallet signs one authorisation for this show; an
 * ephemeral ed25519 key generated in this tab then signs each bid silently. The private half lives in
 * sessionStorage only (per tab, gone when the tab closes), bounded by the `max` and `valid` the wallet signed.
 */
import { useCallback, useEffect, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { PaddleResponse, type MeResponse } from '@/contracts';
import {
  buildPaddleAuth, classifyWalletError, errorKey, generateSessionKey, loadPaddleKey, paddleValidUntil, readFailure, savePaddleKey, toBase64,
  type StoredPaddle,
} from '@/lib/client/bidder';

export interface PaddleError { key: string; values?: Record<string, string>; wallet?: 'rejected' | 'cluster' | 'unsupported' | 'unknown' }

const store = (): Storage | null => { try { return window.sessionStorage; } catch { return null; } };

export function usePaddle(opts: { showId: string; cluster: string | null; wallet: string | null; me: MeResponse | null; nowMs: () => number; refreshMe: () => void }) {
  const { showId, cluster, wallet, me, nowMs, refreshMe } = opts;
  const { signMessage } = useWallet();
  const [key, setKey] = useState<StoredPaddle | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PaddleError | null>(null);

  useEffect(() => {
    setKey(wallet ? loadPaddleKey(store(), showId, wallet, Date.now()) : null);
  }, [showId, wallet]);

  const hasPaddle = !!me?.paddle && Date.parse(me.paddle.validUntil) > nowMs();

  const register = useCallback(async (o: { maxBid: bigint | null; hours: number }): Promise<boolean> => {
    if (!wallet) return false;
    if (!signMessage) { setError({ key: 'errors.noSignMessage' }); return false; }
    setBusy(true);
    setError(null);
    try {
      const session = generateSessionKey();
      const valid = paddleValidUntil(nowMs(), o.hours);
      const message = buildPaddleAuth({ cluster: cluster ?? 'devnet', show: showId, wallet, session: session.publicKey, max: o.maxBid != null ? o.maxBid.toString() : null, valid });
      let signature: string;
      try {
        signature = toBase64(await signMessage(new TextEncoder().encode(message)));
      } catch (e) {
        setError({ key: 'errors.walletSign', wallet: classifyWalletError(e) });
        return false;
      }
      const res = await fetch(`/api/shows/${encodeURIComponent(showId)}/paddle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, signature, sessionPubkey: session.publicKey, ...(o.maxBid != null ? { maxBid: o.maxBid.toString() } : {}) }),
      });
      if (!res.ok) {
        const f = await readFailure(res);
        setError({ key: errorKey(f.code) });
        return false;
      }
      const paddle = PaddleResponse.safeParse(await res.json().catch(() => null));
      if (!paddle.success) { setError({ key: 'errors.generic' }); return false; }
      const stored: StoredPaddle = { ...session, paddleId: paddle.data.paddleId, validUntil: Date.parse(paddle.data.validUntil) };
      savePaddleKey(store(), showId, wallet, stored);
      setKey(stored);
      refreshMe();
      return true;
    } catch {
      setError({ key: 'errors.network' });
      return false;
    } finally {
      setBusy(false);
    }
  }, [wallet, signMessage, cluster, showId, nowMs, refreshMe]);

  return { hasPaddle, key, busy, error, register, clearError: () => setError(null) };
}
