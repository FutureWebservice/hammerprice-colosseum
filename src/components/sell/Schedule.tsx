'use client';

import { useEffect, useState } from 'react';
import { listShows } from './api';
import { ScheduleView, type ScheduleState } from './ScheduleView';

const REFRESH_MS = 15_000;

/** GET /api/shows once per status, refreshed every 15 s (the endpoint is CDN-cached for 5 s) and ticking a clock every second for the countdowns. */
export default function Schedule() {
  const [state, setState] = useState<ScheduleState>({ status: 'loading' });
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [origin, setOrigin] = useState('');

  useEffect(() => {
    setOrigin(window.location.origin);
    let dead = false;
    let timer: ReturnType<typeof setTimeout>;
    // The first load always runs (a link opened in a background tab must not stay empty); refreshes pause while hidden,
    // and the tab refreshes the moment it becomes visible again.
    const load = async (force = false) => {
      if (force || document.visibilityState !== 'hidden') {
        // The house's demo shows come on their own (so a busy seller list can never push the demo room out, and a run of finished demo shows can
        // never fill the seller archive); the three seller lists leave house shows out. The view splits by `isHouse` again, so a mixed answer stays safe.
        const [demo, live, scheduled, ended] = await Promise.all([
          listShows(undefined, 8, 'only'), listShows('live', 10, 'exclude'), listShows('scheduled', 30, 'exclude'), listShows('ended', 10, 'exclude'),
        ]);
        if (!dead) {
          if (demo.ok && live.ok && scheduled.ok && ended.ok) {
            const house = demo.data.shows;
            const of = (status: 'live' | 'scheduled' | 'ended') => house.filter((s) => s.status === status);
            setState({ status: 'ready', live: [...of('live'), ...live.data.shows], scheduled: [...of('scheduled'), ...scheduled.data.shows], ended: [...of('ended'), ...ended.data.shows] });
          } else setState((s) => (s.status === 'ready' ? s : { status: 'error' }));
        }
      }
      if (!dead) {
        clearTimeout(timer);
        timer = setTimeout(() => void load(), REFRESH_MS);
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load(true);
    };
    document.addEventListener('visibilitychange', onVisible);
    void load(true);
    const tick = setInterval(() => setNowMs(Date.now()), 1000);
    return () => {
      dead = true;
      clearTimeout(timer);
      clearInterval(tick);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return <ScheduleView state={state} nowMs={nowMs} origin={origin} />;
}
