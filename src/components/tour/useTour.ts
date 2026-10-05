'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { browserStore } from '@/lib/client/safe-storage';
import { stepsOf, type TourFlow } from './steps';
import { TOUR_EVENT, markTourSeen, stepIndex, wantsAutoTour } from './tour-logic';

/** The element of a step on the page, or null. An anchor inside a hidden element (display none, zero size) does not count. */
export function findAnchor(id: string, flow: TourFlow = 'room'): HTMLElement | null {
  const step = stepsOf(flow).find((s) => s.id === id);
  if (!step) return null;
  const all = document.querySelectorAll<HTMLElement>(`[data-tour="${step.anchor}"]`);
  for (const el of all) if (el.getClientRects().length > 0) return el;
  return null;
}

/** Tour state: -1 is "not running". Steps whose anchor is not on the page are skipped, not shown without a target. */
export function useTour(autoStart: boolean, flow: TourFlow = 'room') {
  const IDS = useMemo(() => stepsOf(flow).map((s) => s.id as string), [flow]);
  const exists = useCallback((id: string) => findAnchor(id, flow) !== null, [flow]);
  const [index, setIndex] = useState(-1);

  const start = useCallback(() => {
    const first = stepIndex(IDS, -1, 1, exists);
    if (first < 0) return false;
    markTourSeen(browserStore('local'));
    setIndex(first);
    return true;
  }, [IDS, exists]);

  // First visit: wait for the room to draw its anchors (it loads first), try for a few seconds, then give up quietly.
  useEffect(() => {
    if (!autoStart || !wantsAutoTour(window.location.search, browserStore('local'))) return undefined;
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      if (start() || tries >= 8) window.clearInterval(timer);
    }, 700);
    return () => window.clearInterval(timer);
  }, [autoStart, start]);

  // "Replay the tour" (HelpMenu) works any time, also after it was seen or skipped.
  useEffect(() => {
    const on = () => { start(); };
    window.addEventListener(TOUR_EVENT, on);
    return () => window.removeEventListener(TOUR_EVENT, on);
  }, [start]);

  const next = useCallback(() => setIndex((i) => stepIndex(IDS, i, 1, exists)), [IDS, exists]);
  const back = useCallback(() => setIndex((i) => { const p = stepIndex(IDS, i, -1, exists); return p < 0 ? i : p; }), [IDS, exists]);
  const stop = useCallback(() => setIndex(-1), []);

  const id = index >= 0 ? IDS[index]! : null;
  const available = id ? IDS.filter(exists) : [];
  return {
    id,
    n: id ? available.indexOf(id) + 1 : 0,
    total: available.length,
    hasNext: index >= 0 && stepIndex(IDS, index, 1, exists) >= 0,
    hasBack: index >= 0 && stepIndex(IDS, index, -1, exists) >= 0,
    next, back, stop,
  };
}
