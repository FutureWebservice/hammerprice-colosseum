'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveSnapshot, ShowDetail } from '@/contracts/api';
import { getShow, getSnapshot, type ApiFail } from './api';

export type ManageData =
  | { status: 'loading' }
  | { status: 'error'; error: ApiFail }
  | { status: 'ready'; detail: ShowDetail; snapshot: LiveSnapshot | null };

const POLL_MS = 2000;
const POLL_SLOW_MS = 10_000;

/**
 * The catalogue once (and on demand), the live snapshot on a poll. The poll skips a tick while the tab is hidden,
 * slows down when the show has ended and backs off after an error, so an idle tab costs almost nothing.
 */
export function useShowManage(showId: string) {
  const [data, setData] = useState<ManageData>({ status: 'loading' });
  const detailRef = useRef<ShowDetail | null>(null);

  const loadDetail = useCallback(async () => {
    const r = await getShow(showId);
    if (r.ok) {
      detailRef.current = r.data;
      setData((d) => ({ status: 'ready', detail: r.data, snapshot: d.status === 'ready' ? d.snapshot : null }));
    } else if (!detailRef.current) setData({ status: 'error', error: r });
    return r;
  }, [showId]);

  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let misses = 0;

    // The first poll always runs (a page opened in a background tab must not start empty); later ones pause while hidden.
    const tick = async (force = false) => {
      let delay = POLL_MS;
      if (force || typeof document === 'undefined' || document.visibilityState !== 'hidden') {
        try {
          const r = await getSnapshot(showId, ctrl.signal);
          if (r.ok) {
            misses = 0;
            setData((d) => (d.status === 'ready' ? { ...d, snapshot: r.data } : d));
            if (r.data.show.status === 'ended') delay = POLL_SLOW_MS;
          } else delay = Math.min(POLL_SLOW_MS, POLL_MS * 2 ** ++misses);
        } catch {
          return; // aborted: the page is gone
        }
      }
      timer = setTimeout(() => void tick(), delay);
    };

    void loadDetail().then(() => {
      if (!ctrl.signal.aborted) void tick(true);
    });
    return () => {
      ctrl.abort();
      if (timer) clearTimeout(timer);
    };
  }, [showId, loadDetail]);

  /** Read the live snapshot now (after the seller's own pause or resume) instead of waiting for the next tick. */
  const reloadSnapshot = useCallback(async () => {
    const r = await getSnapshot(showId);
    if (r.ok) setData((d) => (d.status === 'ready' ? { ...d, snapshot: r.data } : d));
    return r;
  }, [showId]);

  /** Use a snapshot an action already returned (controlLot answers with one) instead of waiting for the next tick. */
  const applySnapshot = useCallback((snapshot: LiveSnapshot) => setData((d) => (d.status === 'ready' ? { ...d, snapshot } : d)), []);

  return { data, reloadDetail: loadDetail, reloadSnapshot, applySnapshot };
}
