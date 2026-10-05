'use client';

/**
 * Sign-in for the room: the same exchange as everywhere else (signInWithWallet: wallet-standard signIn when the wallet has it, else signMessage, with
 * the not-connected retry and the timeout), then the session cookie is set and `onSignedIn` refreshes /api/me. Only the way errors are worded differs:
 * the room keeps its own `errors.*` texts, keyed by the same real causes.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { errorKey } from '@/lib/client/bidder';
import { SignInError, signInWithWallet } from '@/lib/client/session';

export interface RoomSignInError { key: string; wallet?: 'rejected' | 'cluster' | 'unsupported' | 'unknown' | 'notConnected' | 'timeout' }

/** The room text key for a sign-in failure: the real cause, never "you declined" for anything but a decline. */
export function roomSignInError(e: SignInError): RoomSignInError {
  switch (e.code) {
    case 'wallet_rejected': return { key: 'errors.walletSign', wallet: 'rejected' };
    case 'no_sign_message': return { key: 'errors.noSignMessage' };
    case 'not_connected': return { key: 'errors.walletSign', wallet: 'notConnected' };
    case 'timeout': return { key: 'errors.walletSign', wallet: 'timeout' };
    case 'wallet_failed': return { key: 'errors.walletSign', wallet: 'unknown' };
    case 'network': return { key: 'errors.network' };
    default: return { key: errorKey(e.code) };
  }
}

/** `onSignedIn` may return a promise: `busy` stays true until it settles, so the caller never sees "signed out and idle" between the cookie and /api/me. */
export function useRoomSignIn(onSignedIn: () => void | Promise<void>) {
  const wallet = useWallet();
  const walletRef = useRef(wallet);
  useEffect(() => { walletRef.current = wallet; });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RoomSignInError | null>(null);

  const signIn = useCallback(async (): Promise<boolean> => {
    const key = walletRef.current.publicKey;
    if (!key) return false;
    setBusy(true);
    setError(null);
    try {
      await signInWithWallet({ wallet: key.toBase58(), getSigners: () => ({ signMessage: walletRef.current.signMessage, signIn: walletRef.current.signIn }) });
      await onSignedIn();
      return true;
    } catch (e) {
      setError(e instanceof SignInError ? roomSignInError(e) : { key: 'errors.network' });
      return false;
    } finally {
      setBusy(false);
    }
  }, [onSignedIn]);

  return { signIn, busy, error, clearError: () => setError(null) };
}
