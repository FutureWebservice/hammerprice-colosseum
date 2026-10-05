'use client';

/**
 * The broadcast lower third: the one surface that always answers "what is happening right now" without
 * reading the feed. Three faces, one at a time:
 *  - open: the lot's tag, its current bid large in brass, and what that number means.
 *  - going once / going twice: the call takes over in large serif (the countdown bar is in PhaseBanner). On a TIMED lot the call is only
 *    chanted in the last 10 seconds; before that the lower third keeps showing the bid.
 *  - hammered / gap: the result stamped once, held through the pause with a live countdown to the next lot.
 */
import { useTranslations } from 'next-intl';
import { useUsd } from '@/hooks/room/useUsd';
import { timedDisplay } from '@/lib/auction/phase';
import type { RoomLot, RoomPhase } from './types';
import { lotLimit, positiveAmount } from './limit';

const lotLabel = (n: number) => String(n).padStart(2, '0');

export default function LowerThird({
  lot, phase: serverPhase, msToNext, jitterToken, timed = false, msLeft = null,
}: {
  lot: RoomLot | null;
  phase: RoomPhase;
  /** ms until the next lot opens, valid while `phase` is 'hammered' or 'gap'. */
  msToNext: number | null | undefined;
  /** Bumped on every bid: replays the bid figure's roll-in exactly once per bid. */
  jitterToken: number;
  /** The show is a timed show: the call is only drawn in the last 10 seconds. */
  timed?: boolean;
  /** Milliseconds to the lot's close (server clock); only read for a timed show. */
  msLeft?: number | null;
}) {
  const t = useTranslations('room');
  const usd = useUsd();
  if (!lot) return null;
  const phase = timedDisplay(timed ? 'timed' : 'live', serverPhase, msLeft).phase;

  const isCall = phase === 'going-once' || phase === 'going-twice';
  const isSettled = phase === 'hammered' || phase === 'gap';
  const seconds = msToNext != null ? Math.max(0, Math.ceil(msToNext / 1000)) : null;
  const isSold = lot.state === 'sold';
  const limit = lotLimit(lot);
  const isClosed = isSold || lot.state === 'passed' || lot.state === 'withdrawn';

  return (
    <div className={`ar-lt${isCall ? ' is-call' : ''}${isSettled ? ' is-settled' : ''}`}>
      {isSettled && isClosed ? (
        <div className={`ar-lt-result${isSold ? '' : ' is-passed'}`} key={`${lot.id}-${lot.state}`}>
          <span className="ar-lt-result-stamp">{isSold ? t('state.sold') : lot.state === 'passed' ? t('state.passed') : t('state.withdrawn')}</span>
          {isSold && lot.highBid != null && <span className="ar-lt-result-amount">{usd(lot.highBid)}</span>}
          {seconds != null && <span className="ar-lt-next">{t('bid.nextLotIn', { seconds })}</span>}
        </div>
      ) : isCall ? (
        <div className="ar-lt-call">
          <span className="ar-lt-call-text">{phase === 'going-once' ? t('call.once') : t('call.twice')}</span>
        </div>
      ) : (
        <div className="ar-lt-open">
          <div className="ar-lt-tag">
            {t('catalogue.lotNumber', { number: lotLabel(lot.lotNumber) })} · {lot.name}
          </div>
          <div className="ar-lt-bid-row">
            <span key={jitterToken} className="ar-lt-bid is-roll">
              {usd(lot.highBid ?? limit.value ?? positiveAmount(lot.openingPrice))}
            </span>
            <span className="ar-lt-meta">
              {lot.highBid ? t('stage.currentBid') : limit.kind === 'reserve' ? t('stage.estimate') : limit.kind === 'insured' ? t('stage.insured') : t('stage.opening')}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
