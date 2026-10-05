'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RouteResponse, ShowSummary } from '@/contracts/api';
import type { SettlementView } from '@/contracts/chain';
import { getMe, listShows, type ApiFail } from '@/components/sell/api';
import { getActivity, getSettlement, releasePaddle, type ActivityTab } from './api';
import { paddleCandidates, type PendingSettlement } from './desk';

type Activity = RouteResponse<'meActivity'>;
export type ActivityItems<T extends ActivityTab> = Extract<Activity, { tab: T }>['items'];

export type Paged<I> =
  | { status: 'loading' }
  | { status: 'error'; error: ApiFail }
  | { status: 'ready'; items: I[]; nextCursor: string | null; more: boolean; moreError: ApiFail | null };

/** One tab of GET /api/me/activity with "load more". Items accumulate; a failed page keeps what is already shown. */
export function useActivity<T extends ActivityTab>(tab: T) {
  const [state, setState] = useState<Paged<ActivityItems<T>[number]>>({ status: 'loading' });
  const cursor = useRef<string | null>(null);

  const load = useCallback(
    async (more: boolean) => {
      if (more) setState((s) => (s.status === 'ready' ? { ...s, more: true, moreError: null } : s));
      const r = await getActivity(tab, more ? (cursor.current ?? undefined) : undefined);
      if (!r.ok) {
        setState((s) => (s.status === 'ready' && more ? { ...s, more: false, moreError: r } : { status: 'error', error: r }));
        return;
      }
      const page = r.data as Extract<Activity, { tab: T }>;
      const fresh = page.items as unknown as ActivityItems<T>[number][];
      cursor.current = page.nextCursor;
      setState((s) => ({
        status: 'ready',
        items: more && s.status === 'ready' ? [...s.items, ...fresh] : fresh,
        nextCursor: page.nextCursor,
        more: false,
        moreError: null,
      }));
    },
    [tab],
  );

  useEffect(() => {
    cursor.current = null;
    setState({ status: 'loading' });
    void load(false);
  }, [load]);

  return { state, reload: () => load(false), loadMore: () => load(true) };
}

/** Explorer receipts for wins that reached the chain: one GET /api/settlements/:id per settled or submitted win. */
export function useReceipts(settlementIds: string[]) {
  const [views, setViews] = useState<Record<string, SettlementView>>({});
  const key = settlementIds.join(',');
  useEffect(() => {
    let dead = false;
    const todo = settlementIds.filter((id) => !(id in views));
    if (todo.length === 0) return;
    void Promise.all(todo.map((id) => getSettlement(id).then((r) => [id, r.ok ? r.data : null] as const))).then((rows) => {
      if (dead) return;
      setViews((v) => ({ ...v, ...Object.fromEntries(rows.filter((x): x is readonly [string, SettlementView] => x[1] !== null)) }));
    });
    return () => {
      dead = true;
    };
    // `views` is read only to skip ids we already have; re-running on its change would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return views;
}

const DESK_POLL_MS = 5000;

/**
 * Reads the signing round of each open settlement every few seconds while the desk is open (who has signed, how long
 * the round lasts). Skips ticks while the tab is hidden.
 */
export function useDesk(pending: PendingSettlement[]) {
  const [views, setViews] = useState<Record<string, SettlementView>>({});
  const ids = pending.map((p) => p.settlementId).join(',');
  const idsRef = useRef<string[]>([]);
  idsRef.current = ids ? ids.split(',') : [];

  useEffect(() => {
    let dead = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async (force = false) => {
      if (force || document.visibilityState !== 'hidden') {
        const rows = await Promise.all(idsRef.current.map((id) => getSettlement(id).then((r) => [id, r.ok ? r.data : null] as const)));
        if (!dead) setViews(Object.fromEntries(rows.filter((x): x is readonly [string, SettlementView] => x[1] !== null)));
      }
      if (!dead) timer = setTimeout(() => void tick(), DESK_POLL_MS);
    };
    timer = setTimeout(() => void tick(true), 0);
    return () => {
      dead = true;
      clearTimeout(timer);
    };
  }, []);

  return views;
}

export type PaddleRow = { show: ShowSummary; number: number; validUntil: string; funded: boolean };
export type PaddlesState = { status: 'loading' } | { status: 'error'; error: ApiFail } | { status: 'ready'; rows: PaddleRow[] };

/**
 * There is no "my paddles" route, so ask per show that is not over (live and scheduled, at most 8): /api/me?show=<id>
 * carries the caller's paddle for that show.
 */
export function usePaddles() {
  const [state, setState] = useState<PaddlesState>({ status: 'loading' });
  const load = useCallback(async () => {
    const [live, scheduled] = await Promise.all([listShows('live', 10), listShows('scheduled', 10)]);
    const failed = !live.ok ? live : !scheduled.ok ? scheduled : null;
    if (failed) return setState({ status: 'error', error: failed });
    const shows = paddleCandidates([...(live.ok ? live.data.shows : []), ...(scheduled.ok ? scheduled.data.shows : [])]);
    const answers = await Promise.all(shows.map((s) => getMe(s.id).then((r) => [s, r] as const)));
    const rows: PaddleRow[] = [];
    for (const [show, r] of answers) if (r.ok && r.data?.paddle) rows.push({ show, ...r.data.paddle });
    setState({ status: 'ready', rows });
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const release = useCallback(async (showId: string) => {
    const r = await releasePaddle(showId);
    if (r.ok) setState((s) => (s.status === 'ready' ? { ...s, rows: s.rows.filter((x) => x.show.id !== showId) } : s));
    return r;
  }, []);

  return { state, reload: load, release };
}

/**
 * Card names for the open signing requests ("You won Charizard for ..."). /api/me pending rows carry only ids, so the names come from the
 * wins list (buyer) and the consignments list (seller). Never blocks the desk: until the answer arrives the text says "a card".
 */
export function useLotNames(pending: PendingSettlement[]): Record<string, string> {
  const [names, setNames] = useState<Record<string, string>>({});
  const wantWins = pending.some((p) => p.role === 'buyer');
  const wantConsigned = pending.some((p) => p.role === 'seller');
  const key = pending.map((p) => p.lotId).join(',');
  useEffect(() => {
    if (!key) return;
    let dead = false;
    void Promise.all([wantWins ? getActivity('wins') : null, wantConsigned ? getActivity('consignments') : null]).then(([w, c]) => {
      if (dead) return;
      const out: Record<string, string> = {};
      if (w?.ok && w.data.tab === 'wins') for (const i of w.data.items) out[i.lotId] = i.lotName;
      if (c?.ok && c.data.tab === 'consignments') for (const i of c.data.items) out[i.lotId] = i.lotName;
      setNames(out);
    });
    return () => {
      dead = true;
    };
  }, [key, wantWins, wantConsigned]);
  return names;
}
