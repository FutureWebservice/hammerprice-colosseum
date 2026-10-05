'use client';

/**
 * The timed auction's parts of the rooms list (owner: TIMED): the "All / Live / Timed" tabs, the badge and the time left. They only show when the list holds a
 * timed show, so with FEATURE_TIMED off the list looks as it always did. Pure helpers first (tested), then three small components.
 */
import { useLocale, useTranslations } from 'next-intl';
import type { ShowKind } from '@/contracts/common';
import { formatRemaining } from '@/lib/auction/time-format';

export type ScheduleTab = 'all' | 'live' | 'timed';
export const SCHEDULE_TABS: readonly ScheduleTab[] = ['all', 'live', 'timed'];

type Kinded = { kind?: ShowKind };

/** The lists hold at least one timed show. */
export const hasTimed = (...lists: Kinded[][]): boolean => lists.some((l) => l.some((s) => s.kind === 'timed'));

/** `live` is the live rooms (everything that is not timed), `timed` the timed ones, `all` everything. */
export function filterByTab<T extends Kinded>(shows: T[], tab: ScheduleTab): T[] {
  return tab === 'all' ? shows : shows.filter((s) => (tab === 'timed') === (s.kind === 'timed'));
}

/** Milliseconds from `nowMs` to an ISO deadline; null when there is none. */
export function msToDeadline(closesAt: string | null | undefined, nowMs: number): number | null {
  const t = closesAt ? Date.parse(closesAt) : NaN;
  return Number.isFinite(t) ? t - nowMs : null;
}

export function TimedTabs({ tab, onTab }: { tab: ScheduleTab; onTab: (t: ScheduleTab) => void }) {
  const t = useTranslations('timed');
  return (
    <div className="rm-tabs" role="tablist" aria-label={t('rooms.filterLabel')} data-testid="rooms-tabs">
      {SCHEDULE_TABS.map((k) => (
        <button key={k} type="button" role="tab" aria-selected={tab === k} data-testid={`rooms-tab-${k}`} className="rm-tab" onClick={() => onTab(k)}>
          {t(`rooms.${k}`)}
        </button>
      ))}
    </div>
  );
}

export function TimedBadge() {
  const t = useTranslations('timed');
  return <span className="rm-badge" data-testid="badge-timed">{t('rooms.badge')}</span>;
}

/** "Ends in 2 d 03:12:44", drawn from the list's own clock (the room itself uses the server clock). */
export function TimedEnds({ closesAt, nowMs }: { closesAt: string | null | undefined; nowMs: number }) {
  const t = useTranslations('timed');
  const locale = useLocale();
  const left = msToDeadline(closesAt, nowMs);
  return <span className="hpx-chip hpx-chip--gold" data-testid="timed-ends-in">{left === null ? t('rooms.noDeadline') : t('rooms.endsIn', { time: formatRemaining(left, locale) })}</span>;
}
