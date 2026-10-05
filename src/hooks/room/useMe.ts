'use client';

/**
 * GET /api/me?show=: who the session is, the USDC balance, the paddle, the standing and the settlements waiting
 * on this wallet. 204 (no session; 401 from an older deploy) or a session for a different wallet than the connected one) reads as signed out.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { MeResponse } from '@/contracts';

export type MeStatus = 'off' | 'loading' | 'signed_out' | 'ready' | 'error';
export interface MeState { status: MeStatus; me: MeResponse | null }

const POLL_MS = 6_000;

export function useMe(showId: string, wallet: string | null): MeState & { refresh: () => Promise<void> } {
  const [state, setState] = useState<MeState>({ status: 'off', me: null });
  const tick = useRef(0);

  const load = useCallback(async () => {
    if (!wallet) return setState({ status: 'off', me: null });
    const mine = ++tick.current;
    try {
      const res = await fetch(`/api/me?show=${encodeURIComponent(showId)}`, { cache: 'no-store' });
      if (mine !== tick.current) return;
      if (res.status === 204 || res.status === 401) return setState({ status: 'signed_out', me: null });
      if (!res.ok) return setState((s) => ({ status: 'error', me: s.me }));
      const parsed = MeResponse.safeParse(await res.json().catch(() => null));
      if (!parsed.success) return setState((s) => ({ status: 'error', me: s.me }));
      setState(parsed.data.wallet === wallet ? { status: 'ready', me: parsed.data } : { status: 'signed_out', me: null });
    } catch {
      if (mine === tick.current) setState((s) => ({ status: 'error', me: s.me }));
    }
  }, [showId, wallet]);

  useEffect(() => {
    if (!wallet) { setState({ status: 'off', me: null }); return undefined; }
    setState((s) => (s.status === 'off' ? { status: 'loading', me: null } : s));
    void load();
    const id = setInterval(() => { if (!document.hidden) void load(); }, POLL_MS);
    const onVisible = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVisible); };
  }, [wallet, load]);

  return { ...state, refresh: () => load() };
}
