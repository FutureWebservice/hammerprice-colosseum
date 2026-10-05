'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useUsd } from '@/hooks/room/useUsd';
import PhaseBanner from '@/components/room/PhaseBanner';
import { formatSol } from './types';
import type { RoomLot, RoomPhase, RoomShow } from './types';
import { lotLimit, positiveAmount } from './limit';
import LowerThird from './LowerThird';
import StageMedia from '@/components/room/slots/StageMedia';
import LotDescription from '@/components/room/slots/LotDescription';

/** True once, on mount, and again whenever the OS-level setting flips, so the lot-change animation can swap instantly. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    const decide = () => setReduced(mql.matches);
    decide();
    mql.addEventListener('change', decide);
    return () => mql.removeEventListener('change', decide);
  }, []);
  return reduced;
}

type RoomT = ReturnType<typeof useTranslations>;

/** Where the bidding stands against the reserve while the lot is open. Null once closed, or with no reserve. */
export function limitGap(lot: RoomLot): { met: boolean; remaining: string } | null {
  if (lot.state !== 'open' || positiveAmount(lot.reserve) == null) return null;
  const current = lot.highBid ?? lot.openingPrice;
  if (current == null) return null;
  let reserve: bigint;
  let cur: bigint;
  try {
    reserve = BigInt(lot.reserve as string);
    cur = BigInt(current);
  } catch {
    return null;
  }
  if (cur >= reserve) return { met: true, remaining: '0' };
  return { met: false, remaining: (reserve - cur).toString() };
}

/** "$54.00 to reserve" in slate, or "Reserve reached" in brass: a line of type, never a progress bar. */
export function LimitIndicator({ lot, t, usd }: { lot: RoomLot; t: RoomT; usd: (u: string | null | undefined) => string }) {
  const gap = limitGap(lot);
  if (!gap) return null;
  if (gap.met) {
    return (
      <span className="ar-limit is-met">
        <span className="ar-limit-mark" aria-hidden="true" />
        {t('stage.limitReached')}
      </span>
    );
  }
  return <span className="ar-limit is-gap">{t('stage.untilLimit', { amount: usd(gap.remaining) })}</span>;
}

/** The lot's card image on its own in a pool of light: the outgoing card fades while the new one arrives. */
function StageCard({ src, leaving }: { src: string | null; leaving: boolean }) {
  const cls = `ar-video-still ar-stage-card${leaving ? ' is-leaving' : ' is-entering'}`;
  if (!src) return <div className={cls} />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" className={cls} decoding="async" fetchPriority={leaving ? undefined : 'high'} />;
}

export default function Stage({
  show, lot, phase, msLeft, peakMs, extendedBy, msToNext, jitterToken, solUsd = null, startsAt = null,
}: {
  show: RoomShow;
  lot: RoomLot | null;
  phase: RoomPhase;
  /** Milliseconds to the lot's close on the server clock; null when unknown (practice room, no lot open). */
  msLeft: number | null;
  peakMs: number;
  extendedBy: number;
  /** ms until the next lot opens, valid while `phase` is 'hammered' or 'gap'. */
  msToNext: number | null;
  /** Bumped on every new bid: replays the bid figure's roll-in exactly once. */
  jitterToken: number;
  solUsd?: number | null;
  startsAt?: string | null;
}) {
  const t = useTranslations('room');
  const locale = useLocale();
  const usd = useUsd();
  const limit = lot ? lotLimit(lot) : null;
  const limitSol = formatSol(limit?.value, solUsd);

  // The outgoing card is held just long enough to play its leaving animation. Reduced motion never populates it.
  const reducedMotion = useReducedMotion();
  const [outgoingSrc, setOutgoingSrc] = useState<string | null>(null);
  const prevLotRef = useRef<{ id: string; src: string | null } | null>(null);
  useEffect(() => {
    const prev = prevLotRef.current;
    prevLotRef.current = lot ? { id: lot.id, src: lot.imageUrl ?? null } : null;
    if (!lot || !prev || prev.id === lot.id || reducedMotion) return undefined;
    setOutgoingSrc(prev.src);
    const timer = setTimeout(() => setOutgoingSrc(null), 420);
    return () => clearTimeout(timer);
  }, [lot, reducedMotion]);

  return (
    <section className="ar-stage" aria-label={t('a11y.stage')} data-tour="stage">
      <div className="ar-stage-body">
        {/* The card is the stage. A live video (when somebody streams) gets its own 16:9 frame beside or above it, never a wide band around it. */}
        <div className="ar-stage-main">
          <div className="ar-video-fallback is-broadcast">
            {outgoingSrc && <StageCard src={outgoingSrc} leaving />}
            <StageCard key={lot?.id ?? 'none'} src={lot?.imageUrl ?? null} leaving={false} />
          </div>
          <div className="ar-video-wrap">
            <StageMedia showId={show.id} enabled={show.video?.enabled === true} />
          </div>
        </div>
        <div className="ar-stage-info">
          <PhaseBanner phase={phase} msLeft={msLeft} peakMs={peakMs} extendedBy={extendedBy} msToNext={msToNext} showStatus={show.status} startsAt={startsAt} kind={show.kind} closesAt={lot?.closesAt ?? null} title={show.title} showId={show.id} />
          <LowerThird lot={lot} phase={phase} msToNext={msToNext} jitterToken={jitterToken} timed={show.kind === 'timed'} msLeft={msLeft} />
          {lot && (
            <div className="ar-lotline ar-lotline-compact">
              {lot.gradingCompany && <span className="ar-lotline-grade">{lot.gradingCompany} {lot.grade}</span>}
              <span className="ar-lotline-est">
                {limit?.kind === 'none' ? (
                  <b>{t('stage.noMinimum')}</b>
                ) : (
                  <>{limit?.kind === 'insured' ? t('stage.insured') : t('stage.estimate')} <b>{usd(limit?.value)}</b></>
                )}
              </span>
              {/* The SOL figure converts the limit, the number it sits beside. */}
              {limitSol && <span className="ar-lotline-sol">≈ {limitSol}</span>}
              <LimitIndicator lot={lot} t={t} usd={usd} />
            </div>
          )}
          {lot && <LotDescription description={lot.description ?? null} aiAssisted={lot.aiAssisted === true} locale={locale} />}
        </div>
      </div>
    </section>
  );
}
