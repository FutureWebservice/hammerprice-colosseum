'use client';

/**
 * The signed-in state of this browser, for every page under the locale layout. It mounts INSIDE the wallet
 * provider because a session is "this wallet signed in": it follows the connected wallet, and forgets the
 * session the moment that wallet disconnects or changes.
 *
 * Anonymous visitors cost nothing: /api/me is only asked once a wallet is connected (the cookie is HttpOnly,
 * so this is the only way to learn whether it is still good).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { openWalletModal, signInIsWanted, wantSignIn } from '@/components/wallet/walletLoad';
import { afterPick } from '@/components/room/walletConnect';
import { isMobileUa } from '@/components/room/wallets';
import type { MeResponse } from '@/contracts';
import { SignInError, fetchMe, signInWithWallet, signOutRequest } from '@/lib/client/session';
import { TRANSIENT_CODES, browserIntentStore, clearIntent, readIntent, resumeIntent, writeIntent } from '@/lib/client/signInIntent';

export type SessionStatus = 'loading' | 'anonymous' | 'signing-in' | 'signed-in';

export interface SessionState {
  status: SessionStatus;
  /** Set only while `status` is 'signed-in'. */
  me: MeResponse | null;
  /** The last failed sign-in; cleared when the next one starts. `error.code` is what to translate. */
  error: SignInError | null;
  /** Wallet connected? Lets a gate say "Connect wallet" before "Sign in". */
  connected: boolean;
  /**
   * Without a wallet it opens the picker; the wallet the person picks there goes straight on into the signature (on a phone the person taps "Sign in" next:
   * a fresh user gesture, which mobile wallets need). With a wallet it asks the wallet to sign and sets the cookie. Also the retry after an error.
   */
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  /** Re-reads /api/me (optionally for one show's paddle and standing). */
  refresh: (show?: string) => Promise<MeResponse | null>;
}

/** Exported only so a test harness can stand in for the provider. */
export const SessionContext = createContext<SessionState | null>(null);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function SessionProvider({ children }: { children: ReactNode }) {
  const walletState = useWallet();
  const { publicKey, connected, disconnect } = walletState;
  const wallet = publicKey?.toBase58() ?? null;
  // The newest wallet state, read when the wallet is asked (not the one of the render that made the click handler).
  const walletRef = useRef(walletState);
  useEffect(() => { walletRef.current = walletState; });

  const [status, setStatus] = useState<SessionStatus>('loading');
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<SignInError | null>(null);
  const autoTried = useRef(new Set<string>());
  /** The wallet whose existing session we have finished looking up (so a resumed sign-in never races that lookup). */
  const [checkedFor, setCheckedFor] = useState<string | null>(null);
  const busy = useRef(false);

  const apply = useCallback((next: MeResponse | null, forWallet: string | null) => {
    const ok = next !== null && forWallet !== null && next.wallet === forWallet;
    setMe(ok ? next : null);
    setStatus(ok ? 'signed-in' : 'anonymous');
    return ok ? next : null;
  }, []);

  // Follow the connected wallet: a session only counts for the wallet that signed in.
  useEffect(() => {
    let cancelled = false;
    setCheckedFor(null);
    if (!wallet) {
      setMe(null);
      setStatus('anonymous');
      return;
    }
    setStatus('loading');
    const done = (m: MeResponse | null) => {
      if (cancelled) return;
      apply(m, wallet);
      setCheckedFor(wallet);
    };
    fetchMe().then(done).catch((e) => {
      if (!cancelled && e instanceof SignInError && e.code === 'banned') setError(e); // a suspended wallet learns it before it is asked to sign
      done(null);
    });
    return () => { cancelled = true; };
  }, [wallet, apply]);

  const refresh = useCallback(async (show?: string) => {
    try {
      const m = await fetchMe(show);
      return apply(m, wallet);
    } catch {
      return null;
    }
  }, [wallet, apply]);

  const run = useCallback(async (resumed: boolean) => {
    if (busy.current) return;
    setError(null);
    if (!wallet) {
      wantSignIn(); // the picked wallet signs in as soon as it is connected (the effect below)
      openWalletModal();
      return;
    }
    busy.current = true;
    setStatus('signing-in');
    const store = browserIntentStore();
    writeIntent(store, { wallet, at: Date.now(), resumed });
    try {
      // The adapter can report the public key a moment before it reports "connected": give it one short beat.
      if (!walletRef.current.connected) await sleep(300);
      await signInWithWallet({ wallet, getSigners: () => ({ signMessage: walletRef.current.signMessage, signIn: walletRef.current.signIn }) });
      if (!apply(await fetchMe(), wallet)) throw new SignInError('network', 'Signed, but the session cookie was not kept');
      clearIntent(store);
    } catch (e) {
      const err = e instanceof SignInError ? e : new SignInError('network', e instanceof Error ? e.message : undefined);
      setError(err);
      setStatus('anonymous');
      if (!TRANSIENT_CODES.has(err.code)) clearIntent(store);
    } finally {
      busy.current = false;
    }
  }, [wallet, apply]);

  const signIn = useCallback(() => run(false), [run]);

  // A connected wallet without a session goes straight on into the signature: one flow, no second tap on Sign in. That holds for a wallet the person
  // just picked and for one the adapter restored; a restored wallet is asked once per tab (a rejection must not become a prompt on every page load).
  // The wish is dropped after one answer, so a rejected or failed signature leaves the usual Sign in and retry. A suspended wallet is not asked.
  useEffect(() => {
    let restored = false;
    if (wallet && error?.code !== 'banned') {
      try { restored = sessionStorage.getItem('hp.autosign') !== wallet; } catch { restored = !autoTried.current.has(wallet); }
    }
    const step = afterPick({ wanted: signInIsWanted() || restored, looked: wallet !== null && checkedFor === wallet, anonymous: status === 'anonymous', mobile: isMobileUa(navigator.userAgent) });
    if (step === 'wait') return;
    wantSignIn(false);
    if (wallet) {
      autoTried.current.add(wallet);
      try { sessionStorage.setItem('hp.autosign', wallet); } catch { /* the in-memory set above still stops a loop */ }
    }
    if (step === 'sign') void run(false);
  }, [wallet, checkedFor, status, run, error]);

  // The page came back (a phone returns from the wallet app, maybe reloaded): when a sign-in was under way, see whether it went through, else pick it
  // up once more. The tap that started it was the user's gesture; a second resume is never made.
  const resume = useCallback(async () => {
    const store = browserIntentStore();
    if (busy.current || !wallet || checkedFor !== wallet || resumeIntent(store, wallet, Date.now()) === 'none') return;
    const m = await fetchMe().catch(() => null);
    if (apply(m, wallet)) { clearIntent(store); setError(null); return; }
    const i = readIntent(store, Date.now());
    if (!i || i.resumed) { clearIntent(store); return; }
    void run(true);
  }, [wallet, checkedFor, apply, run]);

  useEffect(() => {
    void resume();
    const onShow = () => { if (document.visibilityState === 'visible') void resume(); };
    document.addEventListener('visibilitychange', onShow);
    window.addEventListener('pageshow', onShow);
    return () => {
      document.removeEventListener('visibilitychange', onShow);
      window.removeEventListener('pageshow', onShow);
    };
  }, [resume]);

  const signOut = useCallback(async () => {
    await signOutRequest();
    clearIntent(browserIntentStore());
    setMe(null);
    setStatus('anonymous');
    await disconnect().catch(() => {});
  }, [disconnect]);

  const value = useMemo<SessionState>(
    () => ({ status, me, error, connected, signIn, signOut, refresh }),
    [status, me, error, connected, signIn, signOut, refresh],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider> (mounted in the locale layout)');
  return ctx;
}

/** connect -> signMessage -> POST /api/auth/verify -> cookie. `pending` is true while the wallet prompt or the request is open. */
export function useSignIn() {
  const { signIn, status, error, connected } = useSession();
  return { signIn, pending: status === 'signing-in', error, connected, signedIn: status === 'signed-in' };
}
