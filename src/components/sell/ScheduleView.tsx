'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/lib/i18n';
import type { ShowSummary } from '@/contracts/api';
import { buildIcs, countdown, formatWhen, icsHref } from './datetime';
import { formatUsdc } from './money';
import { DEMO_SHOW_ID } from '@/lib/demo-show';
import { isStartingNow, showTotal, splitRooms, type RoomGroup } from './scheduleRules';
import { TimedBadge, TimedEnds, TimedTabs, filterByTab, hasTimed, type ScheduleTab } from './slots/TimedSchedule';

export type Lists = { live: ShowSummary[]; scheduled: ShowSummary[]; ended: ShowSummary[] };
export type ScheduleState = { status: 'loading' } | { status: 'error' } | ({ status: 'ready' } & Lists);

function Badges({ show }: { show: ShowSummary }) {
  const t = useTranslations('rooms');
  return (
    <p className="rm-badges">
      {show.kind === 'timed' && <TimedBadge />}
      {show.isHouse && <span className="rm-badge rm-badge--demo" data-testid="badge-demo">{t('demo.badge')}</span>}
      {show.isHouse && <span className="rm-badge" data-testid="badge-house">{t('badge.house')}</span>}
      {show.id === DEMO_SHOW_ID && <span className="rm-badge rm-badge--test" data-testid="badge-practice">{t('badge.practice')}</span>}
      {show.cluster === 'devnet' && <span className="rm-badge rm-badge--test" data-testid="badge-devnet">{t('badge.devnet')}</span>}
    </p>
  );
}

/** The plain line on a house card: what the demo teaches. Only house rooms get one. */
function Tutorial({ show }: { show: ShowSummary }) {
  const t = useTranslations('rooms');
  if (!show.isHouse) return null;
  return <p className="rm-tutorial" data-testid="tutorial-line">{t(show.kind === 'timed' ? 'demo.tutorialTimed' : 'demo.tutorialLive')}</p>;
}

/** The card picture area: the first card image on a baize stage, with the status chip on top. Decorative (the title carries the meaning). */
function Media({ show, children }: { show: ShowSummary; children: React.ReactNode }) {
  const src = show.thumbs[0];
  return (
    <div className="rm-media">
      {/* eslint-disable-next-line @next/next/no-img-element -- a card photo straight from the vault CDN (the CSP names that host) */}
      {src ? <img className="rm-media-img" src={src} alt="" loading="lazy" decoding="async" /> : <span className="rm-media-empty" aria-hidden="true" />}
      <div className="rm-media-top">{children}</div>
    </div>
  );
}

function Calendar({ show, origin }: { show: ShowSummary; origin: string }) {
  const t = useTranslations('rooms');
  if (!show.scheduledAt) return null;
  const ics = buildIcs({ id: show.id, title: show.title, startIso: show.scheduledAt, url: `${origin}/room/${show.id}` });
  return <a className="rm-cal hpx-btn hpx-btn--ghost" href={icsHref(ics)} download={`hammerprice-${show.id.slice(0, 8)}.ics`} data-testid="add-to-calendar">{t('addToCalendar')}</a>;
}

function LiveCard({ show, nowMs }: { show: ShowSummary; nowMs: number }) {
  const t = useTranslations('rooms');
  const timed = show.kind === 'timed';
  return (
    <Link href={`/room/${show.id}`} className="rm-card rm-card--live hpx-panel hpx-card-link" data-testid="room-live">
      <Media show={show}>
        {timed ? <TimedEnds closesAt={show.closesAt} nowMs={nowMs} /> : <span className="hpx-chip hpx-chip--live"><span className="hpx-dot" />{t('status.live')}</span>}
        {!timed && <span className="hpx-chip">{t('lots', { count: show.lotCount })}</span>}
      </Media>
      <div className="rm-card-body">
        <h4 className="rm-card-title">{show.title}</h4>
        <Badges show={show} />
        <Tutorial show={show} />
        <span className="rm-enter">{t('enter')}</span>
      </div>
    </Link>
  );
}

function CardGrid({ label, testId, tone, children }: { label: string; testId?: string; tone?: 'live' | 'archive'; children: React.ReactNode }) {
  return (
    <section className={`rm-section${tone === 'archive' ? ' rm-section--archive' : ''}`} data-testid={testId}>
      <h3 className="rm-section-label">{label}</h3>
      <div className="rm-grid">{children}</div>
    </section>
  );
}

function LiveCards({ shows, nowMs, testId }: { shows: ShowSummary[]; nowMs: number; testId?: string }) {
  const t = useTranslations('rooms');
  if (shows.length === 0) return null;
  return <CardGrid label={t('status.live')} testId={testId} tone="live">{shows.map((show) => <LiveCard key={show.id} show={show} nowMs={nowMs} />)}</CardGrid>;
}

function ScheduledRows({ shows, nowMs, origin, testId }: { shows: ShowSummary[]; nowMs: number; origin: string; testId?: string }) {
  const t = useTranslations('rooms');
  const locale = useLocale();
  if (shows.length === 0) return null;
  return (
    <CardGrid label={t('status.scheduled')} testId={testId}>
      {shows.map((show) => {
        const left = show.scheduledAt ? countdown(show.scheduledAt, nowMs) : null;
        return (
          <div key={show.id} className="rm-card rm-card--scheduled hpx-panel" data-testid="room-scheduled">
            <Link href={`/room/${show.id}`} className="rm-card-main hpx-card-link">
              <Media show={show}>
                {show.scheduledAt ? (
                  <span className="hpx-chip hpx-chip--gold" data-testid="countdown">{isStartingNow(show, nowMs) ? t('startingNow') : t('startsIn', { time: left ?? '' })}</span>
                ) : (
                  <span className="hpx-chip hpx-chip--dim">{t('noStartTime')}</span>
                )}
                <span className="hpx-chip">{t('lots', { count: show.lotCount })}</span>
              </Media>
              <div className="rm-card-body">
                <h4 className="rm-card-title">{show.title}</h4>
                {show.scheduledAt && <p className="rm-card-when">{formatWhen(show.scheduledAt, locale)}</p>}
                <Badges show={show} />
                <Tutorial show={show} />
              </div>
            </Link>
            <Calendar show={show} origin={origin} />
          </div>
        );
      })}
    </CardGrid>
  );
}

function EndedRows({ shows, testId }: { shows: ShowSummary[]; testId?: string }) {
  const t = useTranslations('rooms');
  const locale = useLocale();
  if (shows.length === 0) return null;
  return (
    <CardGrid label={t('status.ended')} testId={testId} tone="archive">
      {shows.map((show) => {
        const total = showTotal(show);
        return (
          <Link key={show.id} href={`/room/${show.id}`} className="rm-card rm-card--ended hpx-panel hpx-card-link" data-testid="room-ended">
            <span className="rm-archive-date">{show.startedAt ? formatWhen(show.startedAt, locale) : ''}</span>
            <h4 className="rm-card-title rm-card-title--sm">{show.title}</h4>
            <span className="rm-archive-result">
              {total ? t('endedResult', { lots: show.lotCount, sold: show.soldCount, amount: formatUsdc(total, locale) }) : t('endedNoSale', { lots: show.lotCount })}
            </span>
          </Link>
        );
      })}
    </CardGrid>
  );
}

const count = (g: RoomGroup) => g.live.length + g.scheduled.length + g.ended.length;

/**
 * The schedule for a loaded state. `nowMs` and `origin` come from the client, so the view itself is deterministic.
 * Two groups, always in this order: "Demo rooms (tutorial)" (the house's live show and timed lot, both labelled), then "Real rooms" (made by wallets through the
 * sell flow). A house show is never listed under sellers, whichever list it arrived in.
 */
export function ScheduleView({ state, nowMs, origin }: { state: ScheduleState; nowMs: number; origin: string }) {
  const t = useTranslations('rooms');
  const [tab, setTab] = useState<ScheduleTab>('all'); // the All / Live / Timed tabs only exist while the list holds a timed show
  if (state.status === 'loading') return <p className="rm-empty" role="status" data-testid="rooms-loading">{t('loading')}</p>;
  if (state.status === 'error') {
    return (
      <div className="rm-error" role="alert" data-testid="rooms-error">
        <p>{t('error')} {t('errorAuto')}</p>
        <p><Link href="/room/house">{t('emptyHouse')}</Link></p>
      </div>
    );
  }

  const showTabs = hasTimed(state.live, state.scheduled, state.ended);
  const groups = splitRooms(state, nowMs);
  const view = (g: RoomGroup): RoomGroup => ({ live: filterByTab(g.live, tab), scheduled: filterByTab(g.scheduled, tab), ended: filterByTab(g.ended, tab) });
  const demo = view(groups.demo);
  const sellers = view(groups.sellers);

  return (
    <div className="rm-body">
      {showTabs && <TimedTabs tab={tab} onTab={setTab} />}

      <section className="rm-group rm-group--demo hpx-panel" data-testid="rooms-demo" aria-labelledby="rm-demo-title">
        <h2 className="rm-group-title" id="rm-demo-title">{t('demo.title')} <span className="hpx-chip hpx-chip--demo">{t('demo.badge')}</span></h2>
        <p className="rm-group-sentence">{t('demo.sentence')}</p>
        <p className="rm-group-try">{t('demo.try')}</p>
        <LiveCards shows={demo.live} nowMs={nowMs} />
        {count(groups.demo) === 0 && <p className="rm-group-try"><Link href="/room/house" className="hpx-btn" data-testid="demo-open">{t('demo.open')}</Link></p>}
        <ScheduledRows shows={demo.scheduled} nowMs={nowMs} origin={origin} />
        <EndedRows shows={demo.ended} />
        <p className="rm-demo-footer" data-testid="demo-footer">
          {t('demo.footer')} <Link href="/sell" className="hpx-btn" data-testid="demo-list-card">{t('sellers.cta')}</Link>
        </p>
      </section>

      <section className="rm-group" data-testid="rooms-sellers" aria-labelledby="rm-sellers-title">
        <h2 className="rm-group-title" id="rm-sellers-title">{t('sellers.title')}</h2>
        <p className="rm-group-lede">{t('sellers.lede')}</p>
        <LiveCards shows={sellers.live} nowMs={nowMs} />
        <ScheduledRows shows={sellers.scheduled} nowMs={nowMs} origin={origin} testId="rooms-scheduled" />
        <EndedRows shows={sellers.ended} testId="rooms-ended" />
        {count(groups.sellers) > 0 && count(sellers) === 0 && <p className="rm-group-try" data-testid="rooms-filter-empty">{t('sellers.filterEmpty')}</p>}
        {count(groups.sellers) === 0 && (
          <div className="rm-sellers-empty hpx-panel" data-testid="rooms-empty">
            <h3 className="rm-empty-title">{t('sellers.emptyTitle')}</h3>
            <p>{t('sellers.empty')}</p>
            <p className="rm-empty-actions">
              <Link href="/sell" className="hpx-btn" data-testid="sellers-create">{t('sellers.cta')}</Link>
              <Link href="/about#how" className="hpx-btn hpx-btn--ghost" data-testid="sellers-how">{t('sellers.how')}</Link>
            </p>
            <p className="rm-empty-hint">{t('sellers.secondWallet')}</p>
          </div>
        )}
      </section>
    </div>
  );
}
