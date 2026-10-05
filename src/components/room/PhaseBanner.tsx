'use client';

/**
 * The room's beat in one strip: bidding open, going once, going twice, closed, with the countdown drawn from the
 * server's `closesAt` (corrected by the clock offset) and the anti-snipe extension made visible. The browser only
 * draws the deadline, it never decides one.
 *
 * A TIMED show (one lot for hours or days) draws the same strip with its own wording: the time left as "2 d 03:12:44" or "3 h 12 min", the
 * moment it ends in the viewer's zone, a plain "ends soon" instead of the going once / going twice call until the last 10 seconds, the anti-snipe
 * rule in minutes, the hint to keep USDC ready and an optional calendar entry. A live show is drawn exactly as before.
 */
import { useLocale, useTimeZone, useTranslations } from 'next-intl';
import { formatCountdown } from '@/lib/client/clock';
import { countdownFraction } from '@/components/auction/model';
import type { RoomPhase } from '@/components/auction/types';
import { timedDisplay } from '@/lib/auction/phase';
import { TIMED_RULE_DEFAULTS } from '@/lib/auction/rules';
import { formatDurationLong, formatEndsAt, formatExtension, formatRemaining } from '@/lib/auction/time-format';
import { buildIcs, icsHref } from '@/components/sell/datetime';
import type { ShowKind } from '@/contracts/common';
import Term from '@/components/glossary/Term';
import './room.css';

/** The one-hour calendar entry that ends when the lot ends (the closing time as it stands now: a late bid can move it). */
export function endCalendarHref(i: { showId: string; title: string; closesAtIso: string; url: string; label: string }): string {
  const start = new Date(Date.parse(i.closesAtIso) - 3_600_000).toISOString();
  return icsHref(buildIcs({ id: `${i.showId}-end`, title: i.label, startIso: start, url: i.url }));
}

function TimedNotes({ closesAt, title, showId, locale }: { closesAt: string | null; title: string | null; showId: string | null; locale: string }) {
  const tt = useTranslations('timed');
  const timeZone = useTimeZone(); // the site's zone from the provider (Europe/Berlin); the zone name is printed next to the time
  const r = TIMED_RULE_DEFAULTS;
  const endMs = closesAt ? Date.parse(closesAt) : NaN;
  const url = typeof window !== 'undefined' && showId ? `${window.location.origin}/room/${showId}` : '';
  return (
    <>
      {Number.isFinite(endMs) && <p className="hp-phase-rule" data-testid="timed-ends-at">{tt('endsAt', { time: formatEndsAt(endMs, locale, timeZone) })}</p>}
      <p className="hp-phase-rule" data-testid="timed-rule">{tt('antiSnipe', { window: formatDurationLong(r.snipeWindowS, locale), extend: formatDurationLong(r.snipeExtendS, locale), max: formatDurationLong(r.maxExtensionS, locale) })}</p>
      <p className="hp-phase-rule" data-testid="timed-keep-usdc">{tt('keepUsdc')}</p>
      {Number.isFinite(endMs) && closesAt && showId && title && (
        <p className="hp-phase-rule">
          <a style={{ color: 'var(--brass-br)', textDecoration: 'underline' }} href={endCalendarHref({ showId, title, closesAtIso: closesAt, url, label: tt('calendarTitle', { title }) })} download={`hammerprice-${showId.slice(0, 8)}-end.ics`} data-testid="timed-calendar">{tt('calendar')}</a>
        </p>
      )}
    </>
  );
}

export default function PhaseBanner({
  phase, msLeft, peakMs, extendedBy, msToNext, showStatus, startsAt = null, kind = 'live', closesAt = null, title = null, showId = null,
}: {
  phase: RoomPhase;
  /** Milliseconds to the lot's close on the server clock; null when there is no deadline to draw. */
  msLeft: number | null;
  /** Largest msLeft seen for this lot: the bar's full width. */
  peakMs: number;
  /** Seconds added by the latest anti-snipe extension, 0 when none is being shown. */
  extendedBy: number;
  msToNext: number | null;
  showStatus: 'scheduled' | 'live' | 'ended';
  /** Preformatted start time for a scheduled show (formatted after mount by the caller). */
  startsAt?: string | null;
  /** The show's kind. Absent or 'live': the strip is drawn as it always was. */
  kind?: ShowKind;
  /** Timed only: the lot's deadline (ISO) and the show's title and id, for "ends on ..." and the calendar entry. */
  closesAt?: string | null;
  title?: string | null;
  showId?: string | null;
}) {
  const t = useTranslations('room');
  const tt = useTranslations('timed');
  const locale = useLocale();
  const timed = kind === 'timed';
  const shown = timedDisplay(kind, phase, msLeft);
  const p = shown.phase;
  const counting = p === 'open' || p === 'going-once' || p === 'going-twice';
  const label =
    showStatus === 'ended' ? t('phase.ended')
    : showStatus === 'scheduled' ? (startsAt ? t('phase.starts', { time: startsAt }) : t('status.startingSoon'))
    : shown.soon ? tt('phase.endsSoon')
    : p === 'going-once' ? t('phase.goingOnce')
    : p === 'going-twice' ? t('phase.goingTwice')
    : p === 'open' ? (msLeft != null && msLeft <= 0 ? t('phase.closing') : t('phase.open'))
    : p === 'hammered' ? t('phase.closed')
    : msToNext != null ? t('phase.nextIn', { seconds: Math.max(0, Math.ceil(msToNext / 1000)) })
    : t('phase.waiting');
  const final = counting && msLeft != null && msLeft <= 10_000;

  return (
    <div className={`hp-phase is-${p}${final ? ' is-final' : ''}${timed ? ' is-timed' : ''}`} data-testid="phase-banner" data-phase={p} data-kind={kind} data-tour="clock">
      <div className="hp-phase-row">
        {/* the phase name is announced to screen readers when it changes; the ticking time is not */}
        <span className="hp-phase-label" role="status" aria-live="polite">{label}</span>
        {counting && msLeft != null && (
          <span className="hp-phase-time" data-testid="lot-countdown" aria-label={t('a11y.timer')}>{timed ? formatRemaining(msLeft, locale) : formatCountdown(msLeft)}</span>
        )}
        {extendedBy > 0 && (
          <span className="hp-phase-extended" data-testid="extension-chip">{timed ? tt('extended', { time: formatExtension(extendedBy) }) : t('countdown.extended', { seconds: extendedBy })}</span>
        )}
      </div>
      {counting && msLeft != null && (
        <div className="hp-phase-track" aria-hidden="true">
          <div className="hp-phase-bar" style={{ transform: `scaleX(${countdownFraction(msLeft, peakMs)})` }} />
        </div>
      )}
      {counting && !timed && <p className="hp-phase-rule"><Term id="antiSniping">{t('countdown.antiSnipe')}</Term></p>}
      {counting && timed && showStatus === 'live' && <TimedNotes closesAt={closesAt} title={title} showId={showId} locale={locale} />}
    </div>
  );
}
