'use client';

/**
 * The banner of a paused room (the seller's pause). Everyone in the room sees the same words: the seller paused, bidding
 * resumes with the same time left, and the pause ends by itself at its limit. The sentence is a polite status; the ticking countdown is
 * hidden from screen readers (it would announce every second) and sits next to a plain "ends by itself in about N minutes" they can read.
 */
import { useTranslations } from 'next-intl';
import { formatCountdown } from '@/lib/client/clock';

export default function PauseBanner({ msToResume, msLeft, used, max }: { msToResume: number | null; msLeft: number | null; used: number; max: number }) {
  const t = useTranslations('room');
  const minutes = msToResume == null ? null : Math.max(1, Math.ceil(msToResume / 60_000));
  return (
    <div className="ar-pause" role="status" data-testid="pause-banner">
      <p className="ar-pause-text">
        <strong>{t('pause.title')}</strong> {t('pause.body')}
      </p>
      <p className="ar-pause-meta">
        {msLeft != null && <span>{t('pause.keeps', { time: formatCountdown(Math.max(0, msLeft)) })}</span>}
        <span>{t('pause.count', { used, max })}</span>
        {msToResume != null && (
          <span>
            <span className="sr-only">{t('pause.autoIn', { minutes: minutes ?? 1 })}</span>
            <span aria-hidden="true" data-testid="pause-countdown">{t('pause.autoCountdown', { time: formatCountdown(Math.max(0, msToResume)) })}</span>
          </span>
        )}
      </p>
    </div>
  );
}
