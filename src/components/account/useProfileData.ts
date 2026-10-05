'use client';

/** The reads behind the profile page. Each is one owner-only route; a failure is a state the view shows, never a thrown error. */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RouteResponse, ShowSummary } from '@/contracts/api';
import type { ProfileView } from '@/contracts/profile';
import type { ApiFail } from '@/components/sell/api';
import { getCredits, getMyShows, getProfile, getSummary, getWallet } from './api';

export type Load<T> = { status: 'loading' } | { status: 'error'; error: ApiFail } | { status: 'ready'; data: T };

/** One GET, run on mount and again on `reload`. */
function useLoad<T>(run: () => Promise<{ ok: true; data: T } | ApiFail>): { state: Load<T>; reload: () => void } {
  const [state, setState] = useState<Load<T>>({ status: 'loading' });
  const alive = useRef(true);
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => () => { alive.current = false; }, []);
  const reload = useCallback(() => {
    void runRef.current().then((r) => { if (alive.current) setState(r.ok ? { status: 'ready', data: r.data } : { status: 'error', error: r }); });
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return { state, reload };
}

/** The signed-in user's profile, shared by the header and the editor: `set` takes the server's answer after a save or an upload. */
export function useOwnProfile() {
  const { state, reload } = useLoad(async () => { const r = await getProfile(); return r.ok ? { ok: true as const, data: r.data.profile } : r; });
  const [override, setOverride] = useState<ProfileView | null>(null);
  const shown: Load<ProfileView> = override ? { status: 'ready', data: override } : state;
  return { state: shown, reload, set: setOverride };
}

export const useWalletBalances = () => useLoad(getWallet);
export const useSummary = () => useLoad(getSummary);

/** The AI credits, or `hidden` when AI is off (the route answers feature_off) or costs nothing (AI_FREE). The tab only exists for `ready`. */
export type CreditsState = { status: 'loading' } | { status: 'hidden' } | { status: 'ready'; data: RouteResponse<'aiCredits'> };
export function useCredits(): CreditsState {
  const [state, setState] = useState<CreditsState>({ status: 'loading' });
  useEffect(() => {
    let dead = false;
    void getCredits().then((r) => { if (!dead) setState(r.ok && !r.data.free ? { status: 'ready', data: r.data } : { status: 'hidden' }); });
    return () => { dead = true; };
  }, []);
  return state;
}

/** The rooms this account runs, newest first, with "load more". */
export function useMyRooms() {
  const [state, setState] = useState<Load<{ shows: ShowSummary[]; nextCursor: string | null; more: boolean }>>({ status: 'loading' });
  const cursor = useRef<string | null>(null);
  const load = useCallback(async (more: boolean) => {
    const r = await getMyShows(more ? (cursor.current ?? undefined) : undefined);
    if (!r.ok) return setState((s) => (s.status === 'ready' && more ? { ...s, data: { ...s.data, more: false } } : { status: 'error', error: r }));
    cursor.current = r.data.nextCursor;
    setState((s) => ({ status: 'ready', data: { shows: more && s.status === 'ready' ? [...s.data.shows, ...r.data.shows] : r.data.shows, nextCursor: r.data.nextCursor, more: false } }));
  }, []);
  useEffect(() => { void load(false); }, [load]);
  return { state, reload: () => load(false), loadMore: () => { setState((s) => (s.status === 'ready' ? { ...s, data: { ...s.data, more: true } } : s)); return load(true); } };
}
