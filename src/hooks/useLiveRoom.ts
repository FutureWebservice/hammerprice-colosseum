'use client';

/**
 * The room's data: the catalogue once, the LiveSnapshot by polling (src/lib/client/live.ts has the loop and
 * its tests). Replaces useShowEvents (SSE) and its 200-event slice.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveSnapshot, ShowDetail } from '@/contracts';
import { createLivePoller, fetchCatalogue, LiveError, type PollerState } from '@/lib/client/live';

const INITIAL: PollerState = { status: 'loading', snapshot: null, events: [], offset: 0, errorStreak: 0 };

export interface LiveRoom extends PollerState {
  catalogue: ShowDetail | null;
  catalogueStatus: 'loading' | 'ready' | 'notfound' | 'error';
  /** Fold in a snapshot that came back from the viewer's own bid. */
  applySnapshot: (s: LiveSnapshot) => void;
  /** Poll now. */
  refresh: () => void;
}

export function useLiveRoom(showId: string): LiveRoom {
  const [state, setState] = useState<PollerState>(INITIAL);
  const [catalogue, setCatalogue] = useState<ShowDetail | null>(null);
  const [catalogueStatus, setCatalogueStatus] = useState<LiveRoom['catalogueStatus']>('loading');
  const poller = useRef<ReturnType<typeof createLivePoller> | null>(null);

  useEffect(() => {
    setState(INITIAL);
    const p = createLivePoller({
      showId,
      fetchImpl: (...a) => fetch(...a),
      onState: setState,
      isHidden: () => document.hidden,
      onVisible: (cb) => {
        document.addEventListener('visibilitychange', cb);
        return () => document.removeEventListener('visibilitychange', cb);
      },
    });
    poller.current = p;
    p.start();
    return () => { p.stop(); poller.current = null; };
  }, [showId]);

  useEffect(() => {
    const ctl = new AbortController();
    let retry: ReturnType<typeof setTimeout> | null = null;
    setCatalogue(null);
    setCatalogueStatus('loading');
    const load = (attempt: number) => {
      fetchCatalogue(showId, (...a) => fetch(...a), ctl.signal)
        .then((c) => { setCatalogue(c); setCatalogueStatus('ready'); })
        .catch((e) => {
          if (ctl.signal.aborted) return;
          if (e instanceof LiveError && e.kind === 'not_found') return setCatalogueStatus('notfound');
          if (attempt >= 3) return setCatalogueStatus('error');
          retry = setTimeout(() => load(attempt + 1), 1500 * (attempt + 1));
        });
    };
    load(0);
    return () => { ctl.abort(); if (retry) clearTimeout(retry); };
  }, [showId]);

  const applySnapshot = useCallback((s: LiveSnapshot) => poller.current?.applySnapshot(s), []);
  const refresh = useCallback(() => void poller.current?.poll(), []);

  // A 404 from either endpoint means there is no such show.
  const status = catalogueStatus === 'notfound' ? 'notfound' : state.status;
  return { ...state, status, catalogue, catalogueStatus, applySnapshot, refresh };
}
